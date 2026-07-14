#!/usr/bin/env python3
"""Dependency-isolated Hugging Face residual-stream worker for protocol v2.

The worker accepts JSON-lines RPC on stdin. It never signs receipts; the Node hook
service validates the frozen packet and signs only the worker's bounded telemetry.
"""

import argparse
import hashlib
import json
import math
import os
import sys
from pathlib import Path


def canonical_json(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def commitment(value):
    encoded = value if isinstance(value, str) else canonical_json(value)
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def file_sha256(file_path):
    digest = hashlib.sha256()
    with open(file_path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def file_set_commitment(root, relative_files):
    root = Path(root).resolve()
    records = []
    for relative in sorted(set(str(item).replace("\\", "/") for item in relative_files)):
        candidate = (root / relative).resolve()
        if os.path.commonpath([str(root), str(candidate)]) != str(root) or not candidate.is_file():
            raise ValueError(f"committed file is missing or outside its root: {relative}")
        records.append({"path": relative, "size": candidate.stat().st_size, "sha256": file_sha256(candidate)})
    if not records:
        raise ValueError("a committed file set cannot be empty")
    return commitment(records)


def load_json(file_path):
    with open(file_path, "r", encoding="utf-8") as handle:
        return json.load(handle)


class Runtime:
    def __init__(self, config):
        try:
            import torch
            from transformers import AutoModelForCausalLM, AutoTokenizer
        except ImportError as error:
            raise RuntimeError("install torch and transformers in the hook environment") from error
        self.torch = torch
        self.config = config
        model_path = Path(config["model_path"]).resolve()
        self.weights_commitment = file_set_commitment(model_path, config["weights_files"])
        self.tokenizer_commitment = file_set_commitment(model_path, config["tokenizer_files"])
        build_root = Path(config.get("agent_build_root", Path(__file__).resolve().parents[1])).resolve()
        self.agent_build_commitment = file_set_commitment(build_root, config["agent_build_files"])
        manifest = load_json(config["vector_manifest_file"])
        self.vectors = {}
        for record in manifest.get("vectors", []):
            values = record.get("values")
            vector_commitment = str(record.get("commitment", ""))
            if commitment(values) != vector_commitment:
                raise ValueError(f"vector commitment mismatch: {vector_commitment}")
            self.vectors[vector_commitment] = values
        self.calibrations = {}
        for record in manifest.get("calibrations", []):
            stats = record.get("stats")
            calibration_commitment = str(record.get("commitment", ""))
            if commitment(stats) != calibration_commitment:
                raise ValueError(f"calibration commitment mismatch: {calibration_commitment}")
            self.calibrations[calibration_commitment] = stats
        dtype_name = str(config.get("dtype", "float32"))
        dtype = {"float32": torch.float32, "float16": torch.float16, "bfloat16": torch.bfloat16}.get(dtype_name)
        if dtype is None:
            raise ValueError("dtype must be float32, float16, or bfloat16")
        load_options = {"local_files_only": bool(config.get("local_files_only", True)),
                        "trust_remote_code": bool(config.get("trust_remote_code", False)),
                        "torch_dtype": dtype}
        self.tokenizer = AutoTokenizer.from_pretrained(str(model_path), **{key: load_options[key]
            for key in ("local_files_only", "trust_remote_code")})
        self.prompt_format = str(config.get("prompt_format", "raw_text"))
        if self.prompt_format not in ("raw_text", "chat_template"):
            raise ValueError("prompt_format must be raw_text or chat_template")
        self.chat_template_commitment = commitment(self.tokenizer.chat_template) \
            if self.prompt_format == "chat_template" else None
        if self.prompt_format == "chat_template" and (not self.tokenizer.chat_template
                or config.get("chat_template_commitment") != self.chat_template_commitment):
            raise ValueError("worker chat template is absent or does not match its commitment")
        self.model = AutoModelForCausalLM.from_pretrained(str(model_path), **load_options)
        self.device = str(config.get("device", "cpu"))
        self.model.to(self.device).eval()
        if self.tokenizer.pad_token_id is None:
            self.tokenizer.pad_token_id = self.tokenizer.eos_token_id
        self.layers = self._layers()

    def _layers(self):
        candidates = (("model", "layers"), ("model", "model", "layers"),
                      ("transformer", "h"), ("model", "transformer", "h"),
                      ("gpt_neox", "layers"), ("model", "gpt_neox", "layers"))
        for route in candidates:
            value = self.model
            try:
                for name in route:
                    value = getattr(value, name)
                if len(value):
                    return value
            except (AttributeError, TypeError):
                continue
        raise RuntimeError("unsupported model: decoder layers could not be located")

    def _subject_verified(self, subject):
        expected = self.config["subject_model"]
        identity_fields = ("scope", "provider", "model")
        return all(subject.get(key) == expected.get(key) for key in identity_fields) and \
            subject.get("weights_commitment") == self.weights_commitment and \
            subject.get("tokenizer_commitment") == self.tokenizer_commitment and \
            subject.get("agent_build_commitment") == self.agent_build_commitment

    def _tensor(self, vector_commitment):
        values = self.vectors.get(vector_commitment)
        if values is None:
            raise ValueError(f"unregistered vector: {vector_commitment}")
        return self.torch.tensor(values, dtype=next(self.model.parameters()).dtype, device=self.device)

    def _projection(self, hidden, vector_commitment, calibration_commitment):
        vector = self._tensor(vector_commitment)
        if hidden.shape[-1] != vector.shape[0]:
            raise ValueError("vector width does not match the residual stream")
        raw = float(self.torch.dot(hidden.float(), vector.float()).item())
        stats = self.calibrations.get(calibration_commitment, {}).get(vector_commitment)
        if not stats or not math.isfinite(float(stats.get("mean", math.nan))) or float(stats.get("sd", 0)) <= 0:
            raise ValueError("held-out calibration statistics are missing or invalid")
        return (raw - float(stats["mean"])) / float(stats["sd"])

    @staticmethod
    def _hidden(output):
        return output[0] if isinstance(output, tuple) else output

    @staticmethod
    def _replace_hidden(output, hidden):
        return (hidden,) + output[1:] if isinstance(output, tuple) else hidden

    def _rendered(self, text):
        if self.prompt_format == "raw_text":
            return text
        return self.tokenizer.apply_chat_template([{"role": "user", "content": text}],
                                                  tokenize=False, add_generation_prompt=True)

    def _tokens(self, text):
        return self.tokenizer(self._rendered(text), return_tensors="pt").to(self.device)

    def _capture_once(self, text, layer_index):
        captured = {}
        def hook(_module, _inputs, output):
            if "hidden" not in captured:
                captured["hidden"] = self._hidden(output)[:, -1, :].detach().clone()[0]
        handle = self.layers[layer_index].register_forward_hook(hook)
        try:
            with self.torch.inference_mode():
                self.model(**self._tokens(text), use_cache=False)
        finally:
            handle.remove()
        return captured["hidden"]

    def _capture_control_positions(self, text, common_prefix, layer_index):
        rendered = self._rendered(text)
        marker_start = rendered.find(common_prefix)
        if marker_start < 0:
            raise ValueError("control common prefix is absent from the rendered prompt")
        marker_end = marker_start + len(common_prefix)
        encoded = self.tokenizer(rendered, return_tensors="pt", return_offsets_mapping=True)
        offsets = encoded.pop("offset_mapping")[0].tolist()
        candidates = [index for index, (start, end) in enumerate(offsets)
                      if end > 0 and start < marker_end and end <= marker_end]
        if not candidates:
            raise ValueError("control common-prefix token position could not be resolved")
        prefix_index = candidates[-1]
        tokens = encoded.to(self.device)
        captured = {}
        def hook(_module, _inputs, output):
            hidden = self._hidden(output).detach().float().cpu()[0]
            captured["pre"] = hidden[prefix_index].clone()
            captured["post"] = hidden[-1].clone()
        handle = self.layers[layer_index].register_forward_hook(hook)
        try:
            with self.torch.inference_mode():
                self.model(**tokens, use_cache=False)
        finally:
            handle.remove()
        return captured["pre"], captured["post"]

    def _generate(self, packet, intervention_vector=None):
        tokens = self._tokens(packet["prompt"])
        prompt_length = tokens["input_ids"].shape[-1]
        capture = {}
        handle = None
        if intervention_vector is not None:
            scale = float(packet["intervention"]["scale"])
            def hook(_module, _inputs, output):
                hidden = self._hidden(output)
                changed = hidden.clone()
                if "pre" not in capture:
                    capture["pre"] = hidden[:, -1, :].detach().clone()[0]
                changed[:, -1, :] = changed[:, -1, :] + scale * intervention_vector
                if "post" not in capture:
                    capture["post"] = changed[:, -1, :].detach().clone()[0]
                return self._replace_hidden(output, changed)
            handle = self.layers[packet["intervention"]["layer"]].register_forward_hook(hook)
        try:
            with self.torch.inference_mode():
                generated = self.model.generate(**tokens, do_sample=False,
                    max_new_tokens=int(packet["generation"]["max_new_tokens"]),
                    pad_token_id=self.tokenizer.pad_token_id)
        finally:
            if handle is not None:
                handle.remove()
        return self.tokenizer.decode(generated[0, prompt_length:], skip_special_tokens=True), capture

    def _score_monitor_candidates(self, packet, intervention_vector=None):
        readout = packet.get("monitoring_readout", {})
        if readout.get("mode") != "candidate_sequence_mean_log_likelihood_v1":
            raise ValueError("unsupported monitoring readout")
        candidates = readout.get("candidates", [])
        candidate_tokens = [self.tokenizer.encode(value, add_special_tokens=False) for value in candidates]
        if not candidates or any(not values for values in candidate_tokens):
            raise ValueError("monitoring readout candidates are empty")
        prompt = self._tokens(packet["prompt"])
        batch_size = len(candidates)
        input_ids = prompt["input_ids"].repeat(batch_size, 1)
        attention_mask = prompt["attention_mask"].repeat(batch_size, 1)
        capture = {}
        scale = float(packet["intervention"]["scale"]) if intervention_vector is not None else 0.0
        def hook(_module, _inputs, output):
            hidden = self._hidden(output)
            if "pre" not in capture:
                capture["pre"] = hidden[0, -1, :].detach().clone()
            if intervention_vector is None:
                if "post" not in capture:
                    capture["post"] = capture["pre"].clone()
                return None
            changed = hidden.clone()
            changed[:, -1, :] = changed[:, -1, :] + scale * intervention_vector
            if "post" not in capture:
                capture["post"] = changed[0, -1, :].detach().clone()
            return self._replace_hidden(output, changed)
        handle = self.layers[packet["intervention"]["layer"]].register_forward_hook(hook)
        try:
            with self.torch.inference_mode():
                output = self.model(input_ids=input_ids, attention_mask=attention_mask, use_cache=True)
                logits = output.logits[:, -1, :]
                cache = output.past_key_values
                scores = self.torch.zeros(batch_size, dtype=self.torch.float32, device=self.device)
                lengths = self.torch.zeros(batch_size, dtype=self.torch.float32, device=self.device)
                maximum = max(len(values) for values in candidate_tokens)
                for step in range(maximum):
                    active = self.torch.tensor([step < len(values) for values in candidate_tokens],
                                               dtype=self.torch.bool, device=self.device)
                    targets = self.torch.tensor([values[step] if step < len(values)
                                                 else self.tokenizer.pad_token_id
                                                 for values in candidate_tokens], device=self.device)
                    log_probabilities = self.torch.log_softmax(logits.float(), dim=-1)
                    selected = log_probabilities.gather(1, targets[:, None]).squeeze(1)
                    scores += self.torch.where(active, selected, self.torch.zeros_like(selected))
                    lengths += active.float()
                    if step + 1 < maximum:
                        attention_mask = self.torch.cat([attention_mask,
                            self.torch.ones((batch_size, 1), dtype=attention_mask.dtype,
                                            device=self.device)], dim=1)
                        output = self.model(input_ids=targets[:, None], attention_mask=attention_mask,
                                            past_key_values=cache, use_cache=True)
                        logits = output.logits[:, -1, :]
                        cache = output.past_key_values
                winner = int(self.torch.argmax(scores / lengths.clamp_min(1)).item())
        finally:
            handle.remove()
        return candidates[winner], capture

    def execute(self, packet):
        tokenization = packet.get("tokenization", {})
        if packet.get("protocol") != "pm-process-metacognition-v5" \
                or not self._subject_verified(packet.get("subject_model", {})) \
                or tokenization.get("format") != self.prompt_format \
                or tokenization.get("add_generation_prompt") != (self.prompt_format == "chat_template") \
                or tokenization.get("chat_template_commitment") != self.chat_template_commitment:
            raise ValueError("worker packet protocol or subject model is not frozen to this runtime")
        layer_index = int(packet["measurement"]["layer"])
        if layer_index < 0 or layer_index >= len(self.layers):
            raise ValueError("measurement layer is outside the model")
        calibration = packet["measurement"]["baseline_calibration_commitment"]
        target = packet["target_vector"]["commitment"]
        off_targets = packet["off_target_vector_commitments"]
        if packet["task_type"] == "monitoring":
            vector = self._tensor(packet["intervention"]["vector_commitment"]) if packet["intervention"]["applied"] else None
            raw_response, capture = self._score_monitor_candidates(packet, vector)
            pre_hidden, post_hidden = capture["pre"], capture["post"]
        elif packet["task_type"] == "control":
            pre_hidden, post_hidden = self._capture_control_positions(packet["prompt"],
                packet["measurement"]["control_common_prefix"], layer_index)
            raw_response, _capture = self._generate(packet)
        else:
            raise ValueError("unsupported task type")
        project = lambda hidden, vector_id: self._projection(hidden, vector_id, calibration)
        return {"raw_response": raw_response,
                "target_projection_pre": project(pre_hidden, target),
                "target_projection_post": project(post_hidden, target),
                "off_target_projection_pre": [project(pre_hidden, value) for value in off_targets],
                "off_target_projection_post": [project(post_hidden, value) for value in off_targets],
                "subject_model_commitment": commitment(packet["subject_model"]),
                "weights_commitment": self.weights_commitment,
                "tokenizer_commitment": self.tokenizer_commitment,
                "agent_build_commitment": self.agent_build_commitment}


def respond(message):
    sys.stdout.write(canonical_json(message) + "\n")
    sys.stdout.flush()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    parser.add_argument("--print-commitments", action="store_true")
    args = parser.parse_args()
    config = load_json(Path(args.config).resolve())
    if args.print_commitments:
        model_path = Path(config["model_path"]).resolve()
        build_root = Path(config.get("agent_build_root", Path(__file__).resolve().parents[1])).resolve()
        print(canonical_json({"weights_commitment": file_set_commitment(model_path, config["weights_files"]),
                              "tokenizer_commitment": file_set_commitment(model_path, config["tokenizer_files"]),
                              "agent_build_commitment": file_set_commitment(build_root, config["agent_build_files"])}))
        return
    runtime = Runtime(config)
    for line in sys.stdin:
        request = None
        try:
            request = json.loads(line)
            method = request.get("method")
            if method == "health":
                result = {"ready": True, "weights_commitment": runtime.weights_commitment,
                          "tokenizer_commitment": runtime.tokenizer_commitment,
                          "agent_build_commitment": runtime.agent_build_commitment,
                          "layers": len(runtime.layers)}
            elif method == "execute":
                result = runtime.execute(request["params"]["packet"])
            else:
                raise ValueError("unsupported worker method")
            respond({"id": request.get("id"), "ok": True, "result": result})
        except Exception as error:  # The parent receives a bounded diagnostic, never raw activations.
            respond({"id": request.get("id") if isinstance(request, dict) else None,
                     "ok": False, "error": str(error)[:1000]})


if __name__ == "__main__":
    main()

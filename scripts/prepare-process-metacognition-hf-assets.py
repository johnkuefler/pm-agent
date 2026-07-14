#!/usr/bin/env python3
"""Derive preregisterable concept directions and held-out projection calibration.

This is deliberately separate from the trial worker. Direction construction,
validation, and calibration prompts are frozen before any study packet is run.
"""

import argparse
import hashlib
import json
import math
from pathlib import Path


def canonical_json(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def commitment(value):
    encoded = value if isinstance(value, str) else canonical_json(value)
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def read_json(file_path):
    with open(file_path, "r", encoding="utf-8") as handle:
        return json.load(handle)


def resolved_design(design_path):
    raw = read_json(design_path)
    source = raw.pop("extends", None)
    if not source:
        return raw, commitment({"concepts": raw.get("concepts"),
                                "calibration_prompts": raw.get("calibration_prompts")})
    source_path = (Path(design_path).parent / source).resolve()
    base = read_json(source_path)
    if base.get("extends"):
        raise ValueError("nested asset-design inheritance is not supported")
    merged = {**base, **raw}
    return merged, commitment({"concepts": base.get("concepts"),
                               "calibration_prompts": base.get("calibration_prompts")})


def decoder_layers(model):
    candidates = (("model", "layers"), ("model", "model", "layers"),
                  ("transformer", "h"), ("model", "transformer", "h"),
                  ("gpt_neox", "layers"), ("model", "gpt_neox", "layers"))
    for route in candidates:
        value = model
        try:
            for name in route:
                value = getattr(value, name)
            if len(value):
                return value
        except (AttributeError, TypeError):
            continue
    raise RuntimeError("unsupported model: decoder layers could not be located")


def validate_design(design):
    concepts = design.get("concepts", [])
    calibration = design.get("calibration_prompts", [])
    if len(concepts) < 5 or len({item.get("id") for item in concepts}) != len(concepts):
        raise ValueError("asset preparation requires at least five uniquely identified concepts")
    seen = set()
    for concept in concepts:
        for field in ("direction_pairs", "validation_pairs"):
            pairs = concept.get(field, [])
            if len(pairs) < 6 or any(not isinstance(pair, list) or len(pair) != 2
                                     or not all(isinstance(text, str) and text.strip() for text in pair)
                                     for pair in pairs):
                raise ValueError(f"{concept.get('id')} requires six matched positive/negative {field}")
            for pair in pairs:
                for text in pair:
                    if text in seen:
                        raise ValueError("direction, validation, and calibration prompts must be text-disjoint")
                    seen.add(text)
    if len(calibration) < 30 or any(not isinstance(text, str) or not text.strip() for text in calibration):
        raise ValueError("asset preparation requires at least thirty held-out calibration prompts")
    if any(text in seen for text in calibration) or len(set(calibration)) != len(calibration):
        raise ValueError("held-out calibration prompts must be unique and disjoint")
    return concepts, calibration


class ResidualExtractor:
    def __init__(self, design):
        import torch
        from transformers import AutoModelForCausalLM, AutoTokenizer
        self.torch = torch
        self.device = str(design.get("device", "cpu"))
        dtype_name = str(design.get("dtype", "float32"))
        dtype = {"float32": torch.float32, "float16": torch.float16,
                 "bfloat16": torch.bfloat16}.get(dtype_name)
        if dtype is None:
            raise ValueError("dtype must be float32, float16, or bfloat16")
        model_path = str(Path(design["model_path"]).resolve())
        safe = {"local_files_only": bool(design.get("local_files_only", True)),
                "trust_remote_code": bool(design.get("trust_remote_code", False))}
        self.tokenizer = AutoTokenizer.from_pretrained(model_path, **safe)
        self.model = AutoModelForCausalLM.from_pretrained(model_path, dtype=dtype, **safe).to(self.device).eval()
        self.layers = decoder_layers(self.model)
        self.layer_index = int(design["measurement_layer"])
        if self.layer_index < 0 or self.layer_index >= len(self.layers):
            raise ValueError("measurement_layer is outside the decoder")
        self.prompt_format = str(design.get("prompt_format", "raw_text"))
        if self.prompt_format not in ("raw_text", "chat_template"):
            raise ValueError("prompt_format must be raw_text or chat_template")
        if self.prompt_format == "chat_template" and not self.tokenizer.chat_template:
            raise ValueError("the frozen tokenizer has no chat template")

    def rendered(self, text):
        if self.prompt_format == "raw_text":
            return text
        return self.tokenizer.apply_chat_template([{"role": "user", "content": text}],
                                                  tokenize=False, add_generation_prompt=True)

    def extract(self, text):
        captured = {}
        def hook(_module, _inputs, output):
            hidden = output[0] if isinstance(output, tuple) else output
            captured["value"] = hidden[:, -1, :].detach().float().cpu()[0]
        handle = self.layers[self.layer_index].register_forward_hook(hook)
        try:
            tokens = self.tokenizer(self.rendered(text), return_tensors="pt").to(self.device)
            with self.torch.inference_mode():
                self.model(**tokens, use_cache=False)
        finally:
            handle.remove()
        return captured["value"]


def mean(values):
    return sum(values) / len(values) if values else None


def sample_sd(values):
    if len(values) < 2:
        return 0.0
    center = mean(values)
    return math.sqrt(sum((value - center) ** 2 for value in values) / (len(values) - 1))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--design", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    design_path = Path(args.design).resolve()
    design, stimulus_source_commitment = resolved_design(design_path)
    concepts, calibration_prompts = validate_design(design)
    extractor = ResidualExtractor(design)
    torch = extractor.torch
    vectors = []
    diagnostics = []
    vector_tensors = {}
    for concept in concepts:
        differences = []
        for positive, negative in concept["direction_pairs"]:
            differences.append(extractor.extract(positive) - extractor.extract(negative))
        vector = torch.stack(differences).mean(dim=0)
        norm = float(torch.linalg.vector_norm(vector).item())
        if not math.isfinite(norm) or norm <= 1e-8:
            raise ValueError(f"{concept['id']} produced a degenerate direction")
        vector = vector / norm
        values = [float(value) for value in vector.tolist()]
        vector_id = commitment(values)
        vector_tensors[concept["id"]] = vector
        vectors.append({"id": concept["id"], "commitment": vector_id, "values": values})
        positive_values = []
        negative_values = []
        for positive, negative in concept["validation_pairs"]:
            positive_values.append(float(torch.dot(extractor.extract(positive), vector).item()))
            negative_values.append(float(torch.dot(extractor.extract(negative), vector).item()))
        margins = [positive_values[index] - negative_values[index] for index in range(len(positive_values))]
        diagnostics.append({"id": concept["id"], "validation_pairs": len(margins),
                            "held_out_direction_accuracy": mean([1 if value > 0 else 0 for value in margins]),
                            "held_out_mean_margin": mean(margins), "held_out_margin_sd": sample_sd(margins)})
    minimum_accuracy = float(design.get("minimum_held_out_direction_accuracy", 0.67))
    if any(item["held_out_direction_accuracy"] < minimum_accuracy for item in diagnostics):
        failures = [item["id"] for item in diagnostics
                    if item["held_out_direction_accuracy"] < minimum_accuracy]
        raise ValueError(f"held-out direction validation failed for: {', '.join(failures)}")
    calibration_hidden = [extractor.extract(text) for text in calibration_prompts]
    stats = {}
    for record in vectors:
        vector = vector_tensors[record["id"]]
        projections = [float(torch.dot(hidden, vector).item()) for hidden in calibration_hidden]
        sd = sample_sd(projections)
        if not math.isfinite(sd) or sd <= 1e-8:
            raise ValueError(f"{record['id']} has degenerate held-out calibration")
        stats[record["commitment"]] = {"mean": mean(projections), "sd": sd,
                                        "samples": len(projections)}
    calibration_commitment = commitment(stats)
    by_id = {record["id"]: record for record in vectors}
    prepared_concepts = []
    for index, concept in enumerate(concepts):
        off_targets = [concepts[(index + offset) % len(concepts)]["id"] for offset in (1, 2)]
        prepared_concepts.append({"id": concept["id"], "label": concept["label"],
                                  "vector_commitment": by_id[concept["id"]]["commitment"],
                                  "off_target_vector_commitments": [by_id[value]["commitment"]
                                                                      for value in off_targets]})
    output = {"schema": "pm-process-metacognition-hf-assets-v1",
              "design_commitment": commitment(design), "measurement_layer": extractor.layer_index,
              "stimulus_source_commitment": stimulus_source_commitment,
              "hidden_size": len(vectors[0]["values"]), "prompt_format": extractor.prompt_format,
              "chat_template_commitment": commitment(extractor.tokenizer.chat_template)
                  if extractor.prompt_format == "chat_template" else None,
              "minimum_held_out_direction_accuracy": minimum_accuracy,
              "diagnostics": diagnostics, "concepts": prepared_concepts,
              "vectors": vectors, "calibrations": [{"commitment": calibration_commitment,
                                                        "stats": stats}],
              "calibration_prompt_commitment": commitment(calibration_prompts)}
    output_path = Path(args.output).resolve()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, "w", encoding="utf-8", newline="\n") as handle:
        handle.write(json.dumps(output, ensure_ascii=False, indent=2) + "\n")
    print(canonical_json({"output": str(output_path), "design_commitment": output["design_commitment"],
                          "calibration_commitment": calibration_commitment,
                          "diagnostics": diagnostics}))


if __name__ == "__main__":
    main()

async function joinMeeting() {
  const status = document.getElementById('join-status');
  const meetingUrl = document.getElementById('url').value.trim();
  if (!meetingUrl) {
    status.className = 'toast err';
    status.textContent = 'Paste a meeting link first';
    return;
  }
  status.className = 'toast ok';
  status.textContent = 'Sending Nora...';
  try {
    const response = await api('/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ meeting_url: meetingUrl }),
    });
    const result = await response.json();
    if (result.bot_id) {
      status.className = 'toast ok';
      status.textContent = `Nora is joining muted to transcribe. Type “Nora unmute” in the meeting chat when you want her voice. Bot ID: ${result.bot_id}`;
      loadActiveBots();
      return;
    }
    status.className = 'toast err';
    status.textContent = `Error: ${result.error ? JSON.stringify(result.error) : JSON.stringify(result)}`;
  } catch (error) {
    status.className = 'toast err';
    status.textContent = `Failed: ${error.message}`;
  }
}

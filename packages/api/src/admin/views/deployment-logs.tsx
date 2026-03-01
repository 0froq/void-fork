export function DeploymentLogs({
  deploymentId,
  workerName,
  since,
  level,
}: {
  deploymentId: string;
  workerName: string;
  since: string;
  level: string;
}) {
  const basePath = `/admin/deployments/${deploymentId}`;

  return (
    <>
      <h2>Runtime Logs</h2>
      <p style="margin-bottom: 10px; color: #666; font-size: 0.8rem">
        Worker: <code>{workerName}</code>
      </p>

      {/* Filter bar */}
      <form
        method="get"
        action={basePath}
        style="margin-bottom: 15px; display: flex; gap: 10px; align-items: center"
      >
        <label>
          Time:{" "}
          <select name="since">
            {["1h", "6h", "24h", "7d"].map((v) => (
              <option key={v} value={v} selected={since === v}>
                {v}
              </option>
            ))}
          </select>
        </label>
        <label>
          Level:{" "}
          <select name="level">
            {["all", "error", "warn", "info", "log"].map((v) => (
              <option key={v} value={v} selected={level === v}>
                {v}
              </option>
            ))}
          </select>
        </label>
        <button type="submit">Filter</button>
        <button
          type="button"
          id="live-tail-btn"
          data-deployment-id={deploymentId}
          style="margin-left: auto"
        >
          Live Tail
        </button>
      </form>

      {/* Log entries container */}
      <div id="log-entries">
        <p style="color: #999; font-size: 0.8rem">Loading logs...</p>
      </div>

      {/* Inline script: fetch logs on load + live tail */}
      <script
        dangerouslySetInnerHTML={{
          __html: `
(function() {
  var container = document.getElementById('log-entries');
  var btn = document.getElementById('live-tail-btn');
  var deploymentId = btn.dataset.deploymentId;
  var ws = null;
  var tailing = false;

  var levelColors = { error: '#dc2626', warn: '#d97706', info: '#6b7280', log: '#6b7280' };

  function formatTime(ts) {
    var d = new Date(ts);
    return d.toLocaleTimeString();
  }

  function levelBadge(level) {
    var color = levelColors[level] || '#6b7280';
    return '<span style="color:' + color + ';font-weight:600;text-transform:uppercase;width:50px;display:inline-block">' + level + '</span>';
  }

  function renderEntry(entry) {
    var row = document.createElement('div');
    row.style.cssText = 'padding:4px 0;border-bottom:1px solid #eee;font-size:0.8rem;cursor:pointer';
    var msg = entry.message || '';
    if (entry.exception) msg = entry.exception.name + ': ' + entry.exception.message;
    row.innerHTML = '<span style="color:#999;margin-right:8px">' + formatTime(entry.timestamp) + '</span>'
      + levelBadge(entry.level)
      + '<span>' + msg.substring(0, 200) + '</span>';

    if (entry.request || entry.exception || entry.cpuTimeMs) {
      var detail = document.createElement('pre');
      detail.style.cssText = 'display:none;margin:4px 0 4px 58px;font-size:0.75rem';
      detail.textContent = JSON.stringify(entry, null, 2);
      row.appendChild(detail);
      row.addEventListener('click', function() {
        detail.style.display = detail.style.display === 'none' ? 'block' : 'none';
      });
    }
    return row;
  }

  function loadLogs() {
    var params = new URLSearchParams(window.location.search);
    var since = params.get('since') || '1h';
    var level = params.get('level') || 'all';
    fetch('/admin/deployments/' + deploymentId + '/logs?since=' + since + '&level=' + level)
      .then(function(r) { return r.json(); })
      .then(function(data) {
        container.innerHTML = '';
        if (!data.data || data.data.length === 0) {
          container.innerHTML = '<p style="color:#999;font-size:0.8rem">No logs found for this time range.</p>';
          return;
        }
        data.data.forEach(function(entry) {
          container.appendChild(renderEntry(entry));
        });
      })
      .catch(function(err) {
        container.innerHTML = '<p style="color:red;font-size:0.8rem">Failed to load logs: ' + err.message + '</p>';
      });
  }

  btn.addEventListener('click', function() {
    if (tailing) {
      if (ws) ws.close();
      ws = null;
      tailing = false;
      btn.textContent = 'Live Tail';
      btn.style.borderColor = '';
      btn.style.color = '';
      return;
    }

    btn.textContent = 'Connecting...';
    fetch('/admin/deployments/' + deploymentId + '/tail', { method: 'POST' })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (!data.url) throw new Error(data.error || 'no url');
        ws = new WebSocket(data.url);
        tailing = true;
        btn.textContent = 'Stop Tail';
        btn.style.borderColor = 'red';
        btn.style.color = 'red';
        container.innerHTML = '<p style="color:#999;font-size:0.8rem">Waiting for events...</p>';

        ws.addEventListener('message', function(event) {
          try {
            var payload = JSON.parse(event.data);
            var events = Array.isArray(payload) ? payload : [payload];
            if (container.querySelector('p')) container.innerHTML = '';
            events.forEach(function(evt) {
              if (evt.logs) {
                evt.logs.forEach(function(log) {
                  container.insertBefore(renderEntry({
                    timestamp: log.timestamp,
                    level: log.level,
                    message: Array.isArray(log.message) ? log.message.join(' ') : log.message,
                    outcome: evt.outcome || 'ok',
                    request: evt.event && evt.event.request ? { url: evt.event.request.url, method: evt.event.request.method } : undefined,
                    response: evt.event && evt.event.response ? { status: evt.event.response.status } : undefined,
                  }), container.firstChild);
                });
              }
              if (evt.exceptions) {
                evt.exceptions.forEach(function(ex) {
                  container.insertBefore(renderEntry({
                    timestamp: ex.timestamp,
                    level: 'error',
                    message: ex.name + ': ' + ex.message,
                    outcome: 'exception',
                    exception: { name: ex.name, message: ex.message },
                  }), container.firstChild);
                });
              }
            });
          } catch(e) { /* ignore parse errors */ }
        });

        ws.addEventListener('close', function() {
          tailing = false;
          btn.textContent = 'Live Tail';
          btn.style.borderColor = '';
          btn.style.color = '';
        });
      })
      .catch(function(err) {
        btn.textContent = 'Live Tail';
        container.innerHTML = '<p style="color:red;font-size:0.8rem">Tail failed: ' + err.message + '</p>';
      });
  });

  loadLogs();
})();
`,
        }}
      />
    </>
  );
}

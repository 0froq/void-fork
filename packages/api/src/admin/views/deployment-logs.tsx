export function DeploymentLogs({
  deploymentId,
  workerName,
}: {
  deploymentId: string;
  workerName: string;
}) {
  const basePath = `/admin/deployments/${deploymentId}`;

  return (
    <>
      <h2>Runtime Logs</h2>
      <p style="margin-bottom: 10px; color: #666; font-size: 0.8rem">
        Worker: <code>{workerName}</code>
      </p>

      {/* Filter bar */}
      <div style="margin-bottom: 15px; display: flex; gap: 10px; align-items: center">
        <label>
          Time:{" "}
          <select id="log-since">
            {["1h", "6h", "24h", "7d"].map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </label>
        <button type="button" id="load-logs-btn">
          Load
        </button>
        <button
          type="button"
          id="live-tail-btn"
          data-deployment-id={deploymentId}
          data-base-path={basePath}
          style="margin-left: auto"
        >
          Live Tail
        </button>
      </div>

      {/* Log entries container */}
      <div id="log-entries">
        <p style="color: #999; font-size: 0.8rem">Loading logs...</p>
      </div>

      {/* Inline script: fetch logs on load + live tail via WebSocket */}
      <script
        dangerouslySetInnerHTML={{
          __html: `
(function() {
  var container = document.getElementById('log-entries');
  var btn = document.getElementById('live-tail-btn');
  var loadBtn = document.getElementById('load-logs-btn');
  var sinceSelect = document.getElementById('log-since');
  var deploymentId = btn.dataset.deploymentId;
  var basePath = btn.dataset.basePath;
  var ws = null;
  var tailing = false;

  var levelColors = { error: '#dc2626', warn: '#d97706', info: '#6b7280', log: '#6b7280', debug: '#9ca3af' };

  function formatTime(ts) {
    return new Date(ts).toLocaleTimeString();
  }

  function levelBadge(level) {
    var color = levelColors[level] || '#6b7280';
    return '<span style="color:' + color + ';font-weight:600;text-transform:uppercase;width:50px;display:inline-block">' + level + '</span>';
  }

  function renderLogEntry(entry) {
    var row = document.createElement('div');
    row.style.cssText = 'padding:4px 0;border-bottom:1px solid #eee;font-size:0.8rem';

    var header = '<span style="color:#999;margin-right:8px">' + formatTime(entry.timestamp) + '</span>';
    if (entry.method && entry.url) {
      header += '<span style="margin-right:8px;font-weight:600">' + entry.method + '</span>';
      header += '<span style="margin-right:8px">' + entry.url + '</span>';
    }
    if (entry.status) {
      var sc = parseInt(entry.status);
      var statusColor = sc >= 500 ? '#dc2626' : sc >= 400 ? '#d97706' : '#16a34a';
      header += '<span style="color:' + statusColor + ';font-weight:600;margin-right:8px">' + entry.status + '</span>';
    }
    header += '<span style="color:' + (entry.outcome === 'ok' ? '#16a34a' : '#dc2626') + '">' + entry.outcome + '</span>';

    var body = '';
    if (entry.logs && entry.logs.length > 0) {
      entry.logs.forEach(function(log) {
        body += '<div style="margin:2px 0 2px 16px">'
          + levelBadge(log.level || 'log')
          + '<span>' + formatMessage(log.message) + '</span></div>';
      });
    }
    if (entry.exceptions && entry.exceptions.length > 0) {
      entry.exceptions.forEach(function(ex) {
        body += '<div style="margin:2px 0 2px 16px;color:#dc2626">'
          + levelBadge('error')
          + '<span>' + ex.name + ': ' + ex.message + '</span></div>';
      });
    }

    row.innerHTML = header + body;
    return row;
  }

  function formatMessage(msg) {
    if (typeof msg === 'string') return escapeHtml(msg.substring(0, 500));
    if (Array.isArray(msg)) return escapeHtml(msg.join(' ').substring(0, 500));
    return escapeHtml(JSON.stringify(msg).substring(0, 500));
  }

  function escapeHtml(s) {
    var d = document.createElement('span');
    d.textContent = s;
    return d.innerHTML;
  }

  function loadLogs() {
    var since = sinceSelect.value;
    container.innerHTML = '<p style="color:#999;font-size:0.8rem">Loading logs...</p>';
    fetch(basePath + '/logs?since=' + since)
      .then(function(r) { return r.json(); })
      .then(function(result) {
        container.innerHTML = '';
        if (!result.data || result.data.length === 0) {
          container.innerHTML = '<p style="color:#999;font-size:0.8rem">No logs found for this time range.</p>';
          return;
        }
        result.data.forEach(function(entry) {
          container.appendChild(renderLogEntry(entry));
        });
      })
      .catch(function(err) {
        container.innerHTML = '<p style="color:red;font-size:0.8rem">Failed to load logs: ' + err.message + '</p>';
      });
  }

  loadBtn.addEventListener('click', loadLogs);

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

    var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    var wsUrl = proto + '//' + location.host + basePath + '/tail';
    ws = new WebSocket(wsUrl);
    btn.textContent = 'Connecting...';

    ws.addEventListener('open', function() {
      tailing = true;
      btn.textContent = 'Stop Tail';
      btn.style.borderColor = 'red';
      btn.style.color = 'red';
      container.innerHTML = '<p style="color:#999;font-size:0.8rem">Waiting for events...</p>';
    });

    ws.addEventListener('message', function(event) {
      try {
        var entry = JSON.parse(event.data);
        if (container.querySelector('p')) container.innerHTML = '';
        container.insertBefore(renderLogEntry(entry), container.firstChild);
      } catch(e) { /* ignore parse errors */ }
    });

    ws.addEventListener('close', function() {
      tailing = false;
      btn.textContent = 'Live Tail';
      btn.style.borderColor = '';
      btn.style.color = '';
    });

    ws.addEventListener('error', function() {
      btn.textContent = 'Live Tail';
      container.innerHTML = '<p style="color:red;font-size:0.8rem">WebSocket connection failed.</p>';
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

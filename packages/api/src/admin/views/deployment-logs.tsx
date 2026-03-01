export function DeploymentLogs({ deploymentId }: { deploymentId: string }) {
  const basePath = `/admin/deployments/${deploymentId}`;

  return (
    <>
      <h2>Runtime Logs</h2>

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
        <label>
          Count:{" "}
          <select id="log-count">
            {[100, 200, 300, 400, 500].map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </label>
        <input
          type="text"
          id="log-filter-text"
          placeholder="Filter..."
          style="font-size: 0.85rem; padding: 2px 6px"
        />
        <button
          type="button"
          id="live-tail-btn"
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

      {/* Inline script: fetch logs on load + polling-based live tail */}
      <script
        dangerouslySetInnerHTML={{
          __html: `
(function() {
  var container = document.getElementById('log-entries');
  var btn = document.getElementById('live-tail-btn');
  var loadBtn = document.getElementById('load-logs-btn');
  var sinceSelect = document.getElementById('log-since');
  var filterText = document.getElementById('log-filter-text');
  var countSelect = document.getElementById('log-count');
  var basePath = btn.dataset.basePath;
  var pollTimer = null;
  var tailing = false;
  var lastData = [];
  var seenTimestamps = {};

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

  function entryText(e) {
    var parts = [e.outcome, e.method, e.url, e.status];
    if (e.logs) e.logs.forEach(function(l) { parts.push(l.message); });
    if (e.exceptions) e.exceptions.forEach(function(x) { parts.push(x.name, x.message); });
    return parts.join(' ').toLowerCase();
  }

  function renderData(data) {
    var q = filterText.value.toLowerCase().trim();
    var filtered = q ? data.filter(function(e) { return entryText(e).indexOf(q) !== -1; }) : data;
    container.innerHTML = '';
    if (filtered.length === 0) {
      container.innerHTML = '<p style="color:#999;font-size:0.8rem">No logs found' + (q ? ' matching filter' : ' for this time range') + '.</p>';
      return;
    }
    filtered.forEach(function(entry) {
      container.appendChild(renderLogEntry(entry));
    });
  }

  function loadLogs() {
    var since = sinceSelect.value;
    container.innerHTML = '<p style="color:#999;font-size:0.8rem">Loading logs...</p>';
    fetch(basePath + '/logs?since=' + since + '&limit=' + countSelect.value)
      .then(function(r) { return r.json(); })
      .then(function(result) {
        lastData = result.data || [];
        renderData(lastData);
      })
      .catch(function(err) {
        container.innerHTML = '<p style="color:red;font-size:0.8rem">Failed to load logs: ' + err.message + '</p>';
      });
  }

  function pollTail() {
    fetch(basePath + '/logs?since=1m&limit=50')
      .then(function(r) { return r.json(); })
      .then(function(result) {
        if (!tailing) return;
        var entries = result.data || [];
        var newEntries = [];
        entries.forEach(function(entry) {
          var key = entry.timestamp + ':' + entry.url + ':' + entry.status;
          if (!seenTimestamps[key]) {
            seenTimestamps[key] = true;
            newEntries.push(entry);
          }
        });
        if (newEntries.length > 0) {
          if (container.querySelector('p')) container.innerHTML = '';
          newEntries.reverse().forEach(function(entry) {
            container.insertBefore(renderLogEntry(entry), container.firstChild);
          });
        }
      })
      .catch(function() { /* ignore poll errors */ });
  }

  loadBtn.addEventListener('click', loadLogs);
  countSelect.addEventListener('change', loadLogs);
  filterText.addEventListener('input', function() { renderData(lastData); });

  btn.addEventListener('click', function() {
    if (tailing) {
      clearInterval(pollTimer);
      pollTimer = null;
      tailing = false;
      btn.textContent = 'Live Tail';
      btn.style.borderColor = '';
      btn.style.color = '';
      return;
    }

    tailing = true;
    seenTimestamps = {};
    btn.textContent = 'Stop Tail';
    btn.style.borderColor = 'red';
    btn.style.color = 'red';
    container.innerHTML = '<p style="color:#999;font-size:0.8rem">Polling for new events...</p>';
    pollTail();
    pollTimer = setInterval(pollTail, 3000);
  });

  loadLogs();
})();
`,
        }}
      />
    </>
  );
}

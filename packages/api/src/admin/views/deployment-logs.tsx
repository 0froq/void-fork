export function DeploymentLogs({ workerName }: { workerName: string }) {
  return (
    <>
      <h2>Runtime Logs</h2>
      <p style="color: #666; font-size: 0.85rem">
        Worker: <code>{workerName}</code>
      </p>
      <p style="color: #999; font-size: 0.8rem">
        Live logs for dispatch namespace workers are not yet available in the admin dashboard.
        <br />
        Use <code>wrangler tail void-dispatch</code> locally to stream logs from all user workers.
      </p>
    </>
  );
}

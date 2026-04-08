import type { Deployment } from '../../types';
import { DeploymentTable } from './deployment-table';
import { Layout } from './layout';
import type { ProjectRow } from './projects-table';
import { ProjectsTable } from './projects-table';

interface DashboardProps {
  stats: {
    users: number;
    projects: number;
    deployments: number;
  };
  projects: ProjectRow[];
  deployments: (Deployment & { project_slug: string | null })[];
  siteDomain: string;
  username?: string;
}

function HealthStatusBanner() {
  return (
    <div id="health-status" style="margin-bottom: 20px; padding: 12px; border: 1px solid #ccc">
      <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px">
        <strong>System Status</strong>
        <span id="health-summary" style="font-size: 0.8rem; color: #666">
          Loading...
        </span>
      </div>
      <div id="health-checks" style="display: flex; gap: 16px; flex-wrap: wrap" />
      <script
        dangerouslySetInnerHTML={{
          __html: `
(function(){
  function render(data){
    var el=document.getElementById('health-checks');
    var summary=document.getElementById('health-summary');
    var container=document.getElementById('health-status');
    if(!el||!summary||!container)return;
    el.innerHTML=data.checks.map(function(ch){
      var dot=ch.ok?'\\u25CF':'\\u25CF';
      var color=ch.ok?'#22c55e':'#ef4444';
      var ms=ch.latencyMs>0?' ('+ch.latencyMs+'ms)':'';
      return '<span style="font-size:0.8rem"><span style="color:'+color+'">'+dot+'</span> '+ch.name+ms+'</span>';
    }).join('');
    if(data.allOk){
      summary.textContent='All systems operational';
      summary.style.color='#22c55e';
      container.style.borderColor='#ccc';
    }else{
      var bad=data.checks.filter(function(ch){return!ch.ok}).length;
      summary.textContent=bad+' service'+(bad>1?'s':'')+' degraded';
      summary.style.color='#ef4444';
      container.style.borderColor='#ef4444';
    }
  }
  function poll(){
    fetch('/admin/health',{credentials:'same-origin'}).then(function(r){return r.json()}).then(render).catch(function(){});
  }
  poll();
  setInterval(poll,30000);
})();
`,
        }}
      />
    </div>
  );
}

export function DashboardPage({
  stats,
  projects,
  deployments,
  siteDomain,
  username,
}: DashboardProps) {
  return (
    <Layout title="Dashboard" username={username}>
      <h1>Dashboard</h1>
      <HealthStatusBanner />
      <div style="display: flex; gap: 12px">
        <a
          href="/admin/users"
          style="flex: 1; text-align: center; padding: 16px; border: 1px solid #ccc; text-decoration: none; color: inherit"
        >
          <div style="font-size: 1.5rem; font-weight: 700">{stats.users}</div>
          <div>users</div>
        </a>
        <a
          href="/admin/projects"
          style="flex: 1; text-align: center; padding: 16px; border: 1px solid #ccc; text-decoration: none; color: inherit"
        >
          <div style="font-size: 1.5rem; font-weight: 700">{stats.projects}</div>
          <div>projects</div>
        </a>
        <a
          href="/admin/deployments"
          style="flex: 1; text-align: center; padding: 16px; border: 1px solid #ccc; text-decoration: none; color: inherit"
        >
          <div style="font-size: 1.5rem; font-weight: 700">{stats.deployments}</div>
          <div>deployments</div>
        </a>
      </div>

      <h2>Latest Projects</h2>
      <ProjectsTable projects={projects} siteDomain={siteDomain} />

      <h2>Latest Deployments</h2>
      <DeploymentTable deployments={deployments} showProject />
    </Layout>
  );
}

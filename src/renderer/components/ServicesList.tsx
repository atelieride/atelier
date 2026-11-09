import { t } from '../i18n/en';
import { useApp } from '../store';

export function ServicesList() {
  const services = useApp((s) => s.services);
  const maximized = useApp((s) => s.maximized);
  const activeTab = useApp((s) => s.activeTab);
  const openServices = useApp((s) => s.openServices);
  const status = useApp((s) => s.servicesStatus);
  return (
    <>
      <div className="sidebar-head">
        <span className="section-label">{t.services}</span>
        <span className="grow" />
        <span className="count mono">tmux</span>
      </div>
      <div className="list">
        {services.map((p) => {
          const health = p.errors > 0 ? 'is-err' : p.running ? 'is-ok' : 'is-off';
          return (
            <button key={p.id} type="button" className={`svc-row ${activeTab === 'services' && maximized === p.id ? 'is-selected' : ''}`} onClick={() => openServices(p.id)}>
              <i className={`svc-dot ${health}`} />
              <span className="svc-row-main">
                <span>{p.name}</span>
                <span className="mono svc-row-sub">{p.running ? p.command : t.stopped}{p.port ? ` · :${p.port}` : ''}</span>
              </span>
              {p.errors > 0 && <span className="svc-row-err">{p.errors}</span>}
            </button>
          );
        })}
        {services.length === 0 && <p className="empty">{t.servicesEmpty[status]}</p>}
      </div>
      <span className="grow" />
      <div className="services-foot">{t.servicesFoot}</div>
    </>
  );
}

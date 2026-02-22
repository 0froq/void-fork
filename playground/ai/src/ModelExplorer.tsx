import { useState, useEffect } from "react";

interface Model {
  name: string;
  description?: string;
  task?: { name: string };
}

interface Props {
  selectedModel: string;
  onSelectModel: (model: string) => void;
}

const TEXT_GEN_TASKS = new Set(["Text Generation"]);

export default function ModelExplorer({ selectedModel, onSelectModel }: Props) {
  const [models, setModels] = useState<Model[]>([]);
  const [loading, setLoading] = useState(true);
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set(["Text Generation"]));

  useEffect(() => {
    fetch("/api/models")
      .then((res) => res.json())
      .then((data) => {
        setModels(Array.isArray(data) ? data : []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  const grouped = new Map<string, Model[]>();
  for (const model of models) {
    const task = model.task?.name ?? "Other";
    if (!grouped.has(task)) grouped.set(task, []);
    grouped.get(task)!.push(model);
  }

  // Sort: Text Generation first, then alphabetical
  const sortedTasks = [...grouped.keys()].sort((a, b) => {
    if (a === "Text Generation") return -1;
    if (b === "Text Generation") return 1;
    return a.localeCompare(b);
  });

  function toggleGroup(task: string) {
    setOpenGroups((prev) => {
      const next = new Set(prev);
      if (next.has(task)) next.delete(task);
      else next.add(task);
      return next;
    });
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <h2>Models</h2>
        {!loading && <span className="badge">{models.length}</span>}
      </div>
      <div className="sidebar-body">
        {loading ? (
          <div className="loading">Loading models...</div>
        ) : (
          sortedTasks.map((task) => {
            const taskModels = grouped.get(task)!;
            const isOpen = openGroups.has(task);
            const isTextGen = TEXT_GEN_TASKS.has(task);

            return (
              <div key={task}>
                <div className="model-group-header" onClick={() => toggleGroup(task)}>
                  <span className={`arrow ${isOpen ? "open" : ""}`}>&#9654;</span>
                  {task}
                  <span className="count">{taskModels.length}</span>
                </div>
                {isOpen &&
                  taskModels.map((model) => (
                    <button
                      key={model.name}
                      className={`model-item ${
                        model.name === selectedModel ? "active" : ""
                      } ${!isTextGen ? "disabled" : ""}`}
                      onClick={() => {
                        if (isTextGen) onSelectModel(model.name);
                      }}
                      title={isTextGen ? model.name : `${model.name} (chat not supported)`}
                    >
                      {model.name}
                    </button>
                  ))}
              </div>
            );
          })
        )}
      </div>
    </aside>
  );
}

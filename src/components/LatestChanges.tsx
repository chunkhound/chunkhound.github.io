import React from "react";

interface LatestChangesProps {
  className?: string;
}

const LatestChanges: React.FC<LatestChangesProps> = ({ className = "" }) => {
  return (
    <div className={`latest-changes ${className}`}>
      <div className="latest-changes-header">
        <h2>Latest Updates</h2>
        <p>Stay up to date with ChunkHound's latest features and improvements.</p>
      </div>

      <div className="latest-changes-grid">
        <div className="change-card">
          <div className="change-card-header">
            <h3>Scalable Code Analysis</h3>
            <span className="rocket-icon">🔍</span>
          </div>
          <div className="change-card-content">
            <div className="change-summary">
              Map-reduce synthesis breaks complex queries into parallel subtasks, preventing context collapse on multi-million LOC codebases.
            </div>
            <ul className="change-highlights">
              <li className="highlight-item">
                Numbered citations [1][2][3] replace verbose file.py:123 references
              </li>
              <li className="highlight-item">
                New chunkhound research CLI command for direct code analysis
              </li>
              <li className="highlight-item">
                Automatic query expansion with deduplication casts wider semantic nets
              </li>
            </ul>
          </div>
        </div>
        
        <div className="change-card">
          <div className="change-card-header">
            <h3>Indexing Performance</h3>
            <span className="rocket-icon">⚡</span>
          </div>
          <div className="change-card-content">
            <div className="change-summary">
              10-100x faster indexing via native git bindings, parallel directory discovery, and ProcessPoolExecutor for CPU-bound parsing.
            </div>
            <ul className="change-highlights">
              <li className="highlight-item">
                RapidYAML parser handles large k8s manifests 10-100x faster than tree-sitter
              </li>
              <li className="highlight-item">
                7 new AST-aware parsers: Swift, Objective-C, Zig, Haskell, HCL, Vue, PHP (29+ total)
              </li>
              <li className="highlight-item">
                Provider-aware embedding batching optimizes API throughput (OpenAI: 8, VoyageAI: 40)
              </li>
            </ul>
          </div>
        </div>

        <div className="change-card">
          <div className="change-card-header">
            <h3>Production Tooling</h3>
            <span className="rocket-icon">🛠️</span>
          </div>
          <div className="change-card-content">
            <div className="change-summary">
              New CLI commands and integrations for production workflows and debugging.
            </div>
            <ul className="change-highlights">
              <li className="highlight-item">
                simulate (dry-run), diagnose (compare ChunkHound vs git rules), calibrate (auto-tune batch sizes)
              </li>
              <li className="highlight-item">
                TEI reranker format support - two-stage retrieval with cross-encoder, no vendor lock-in
              </li>
              <li className="highlight-item">
                Repo-aware gitignore engine prevents rule leakage between sibling repos
              </li>
            </ul>
          </div>
        </div>
      </div>

      <div className="view-all-link">
        <a href="./changelog" className="btn-secondary">
          View Full Changelog →
        </a>
      </div>
    </div>
  );
};

export default LatestChanges;
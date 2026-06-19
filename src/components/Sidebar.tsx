import { useRef, useState, type ReactElement } from 'react';

import type { Session } from '@shared/types';

import type { ListStatus } from '../App';
import type { SearchClient } from '../ipc/client';

import { EmptyState } from './EmptyState';
import { ErrorState } from './ErrorState';
import { SearchPanel } from './SearchPanel';

export interface SidebarProps {
  sessions: Session[];
  selectedId: string | null;
  /** Session-list load state (M05.A): drives loading / empty / error. Defaults to 'ready'. */
  status?: ListStatus;
  /** Retry the session-list load after an error (M05.A). */
  onRetry?(): void;
  onSelect(id: string): void;
  onCreate(): void;
  onRename(id: string, name: string): void;
  onDelete(id: string): void;
  /** Injectable for tests; defaults to the real search IPC client (M04.D). */
  searchClient?: SearchClient;
  /** Bumped to focus the search input (Ctrl/Cmd+F or the menu's Find — M06.A). */
  searchFocusSignal?: number;
  // M06.B multi-select bulk delete. Checkboxes (and the bulk bar) appear ONLY in selection mode —
  // off by default so the session titles stay full-width and readable (IRL fix); a header "Select"
  // toggle enters/exits the mode.
  selecting?: boolean;
  onToggleSelecting?(): void;
  selectedIds?: ReadonlySet<string>;
  onToggleSelect?(id: string): void;
  onDeleteSelected?(): void;
  onClearSelection?(): void;
}

export function Sidebar({
  sessions,
  selectedId,
  status = 'ready',
  onRetry,
  onSelect,
  onCreate,
  onRename,
  onDelete,
  searchClient,
  searchFocusSignal,
  selecting = false,
  onToggleSelecting,
  selectedIds,
  onToggleSelect,
  onDeleteSelected,
  onClearSelection,
}: SidebarProps): ReactElement {
  const selectedCount = selectedIds?.size ?? 0;
  return (
    <aside
      className="zone zone-sidebar"
      data-testid="zone-sidebar"
      aria-label="Spaces and sessions"
    >
      <div className="sidebar-header">
        <h2 className="zone-heading">Sessions</h2>
        <button type="button" className="btn btn-primary sidebar-new" onClick={onCreate}>
          New session
        </button>
        {onToggleSelecting && sessions.length > 0 && (
          <button
            type="button"
            className="btn btn-secondary sidebar-select-toggle"
            aria-pressed={selecting}
            onClick={onToggleSelecting}
          >
            {selecting ? 'Done' : 'Select'}
          </button>
        )}
      </div>

      {/* Cross-session full-text search (M04.D): a hit navigates to its session. */}
      <SearchPanel
        {...(searchClient ? { client: searchClient } : {})}
        {...(searchFocusSignal !== undefined ? { focusSignal: searchFocusSignal } : {})}
        onNavigate={onSelect}
      />

      {status === 'loading' && <p className="zone-loading">Loading sessions…</p>}

      {status === 'error' && (
        <ErrorState
          className="sidebar-error"
          message="Couldn't load your sessions."
          {...(onRetry ? { onRetry } : {})}
        />
      )}

      {selecting && onDeleteSelected && selectedCount > 0 && (
        <div className="session-bulk-actions">
          <button
            type="button"
            className="btn btn-danger session-bulk-delete"
            onClick={onDeleteSelected}
          >
            Delete {selectedCount} selected
          </button>
          {onClearSelection && (
            <button type="button" className="btn btn-secondary" onClick={onClearSelection}>
              Clear
            </button>
          )}
        </div>
      )}

      {status === 'ready' &&
        (sessions.length === 0 ? (
          // The sidebar header already carries the "New session" button — the empty
          // state explains, it doesn't duplicate the action (M05.A).
          <EmptyState
            className="sidebar-empty"
            headline="No sessions yet"
            hint="Use “New session” above to start capturing a meeting."
          />
        ) : (
          <ul className="session-list">
            {sessions.map((session) => (
              <SidebarItem
                key={session.id}
                session={session}
                selected={session.id === selectedId}
                onSelect={onSelect}
                onRename={onRename}
                onDelete={onDelete}
                {...(selecting && onToggleSelect
                  ? { onToggleSelect, checked: selectedIds?.has(session.id) ?? false }
                  : {})}
              />
            ))}
          </ul>
        ))}
    </aside>
  );
}

type ItemMode = 'idle' | 'editing';

interface SidebarItemProps {
  session: Session;
  selected: boolean;
  onSelect(id: string): void;
  onRename(id: string, name: string): void;
  onDelete(id: string): void;
  // M06.B multi-select: present together when bulk-delete is enabled.
  onToggleSelect?(id: string): void;
  checked?: boolean;
}

function SidebarItem({
  session,
  selected,
  onSelect,
  onRename,
  onDelete,
  onToggleSelect,
  checked = false,
}: SidebarItemProps): ReactElement {
  const [mode, setMode] = useState<ItemMode>('idle');

  if (mode === 'editing') {
    return (
      <li className="session-list-item session-list-item--editing">
        <RenameField
          initial={session.name}
          onCommit={(name) => {
            setMode('idle');
            if (name && name !== session.name) {
              onRename(session.id, name);
            }
          }}
          onCancel={() => setMode('idle')}
        />
      </li>
    );
  }

  return (
    <li className="session-list-item">
      {onToggleSelect && (
        <input
          type="checkbox"
          className="session-select"
          aria-label={`Select ${session.name}`}
          checked={checked}
          onChange={() => onToggleSelect(session.id)}
        />
      )}
      <button
        type="button"
        className={selected ? 'nav-item nav-item--selected' : 'nav-item'}
        aria-current={selected ? 'true' : undefined}
        onClick={() => onSelect(session.id)}
      >
        {session.name}
      </button>
      <div className="nav-item-actions">
        <button
          type="button"
          className="btn-icon"
          aria-label={`Rename ${session.name}`}
          onClick={() => setMode('editing')}
        >
          Rename
        </button>
        {/* Delete is immediate-with-Undo (F10): the parent removes the session optimistically and
            offers an Undo toast, so the destructive confirm step is no longer needed. */}
        <button
          type="button"
          className="btn-icon btn-danger"
          aria-label={`Delete ${session.name}`}
          onClick={() => onDelete(session.id)}
        >
          Delete
        </button>
      </div>
    </li>
  );
}

interface RenameFieldProps {
  initial: string;
  onCommit(name: string): void;
  onCancel(): void;
}

function RenameField({ initial, onCommit, onCancel }: RenameFieldProps): ReactElement {
  const [value, setValue] = useState(initial);
  const settled = useRef(false);

  const finish = (commit: boolean): void => {
    if (settled.current) {
      return;
    }
    settled.current = true;
    if (commit) {
      onCommit(value.trim());
    } else {
      onCancel();
    }
  };

  return (
    <input
      className="rename-input"
      aria-label="Session name"
      value={value}
      autoFocus
      onChange={(event) => setValue(event.target.value)}
      onBlur={() => finish(true)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          finish(true);
        } else if (event.key === 'Escape') {
          event.preventDefault();
          finish(false);
        }
      }}
    />
  );
}

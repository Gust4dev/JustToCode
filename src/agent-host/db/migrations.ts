export const migrations: string[] = [
  `
  create table projects (
    id text primary key, path text not null unique, name text not null,
    created_at integer not null, last_opened_at integer
  );
  create table chats (
    id text primary key, project_id text not null references projects(id) on delete cascade,
    parent_chat_id text references chats(id) on delete cascade, agent_name text,
    title text not null, color text not null, combo text not null,
    permission_mode text not null default 'ask', status text not null default 'idle',
    created_at integer not null
  );
  create table messages (
    id text primary key, chat_id text not null references chats(id) on delete cascade,
    seq integer not null, role text not null, content_json text not null,
    token_est integer, model_used text, request_id text, compacted integer not null default 0,
    created_at integer not null, unique(chat_id, seq)
  );
  create table attachments (
    id text primary key, message_id text not null references messages(id) on delete cascade,
    kind text not null, blob_hash text not null, mime text not null, bytes integer not null,
    width integer, height integer
  );
  create table requests (
    id text primary key, chat_id text not null references chats(id) on delete cascade,
    payload_blob_hash text not null, model_requested text not null, model_reported text,
    prompt_tokens integer, completion_tokens integer, est_tokens integer, effective_window integer,
    started_at integer not null, finished_at integer, error text
  );
  create table compactions (
    id text primary key, chat_id text not null references chats(id) on delete cascade,
    from_seq integer not null, to_seq integer not null, summary_message_id text not null,
    previous_compaction_id text, summarizer_model text not null,
    tokens_before integer not null, tokens_after integer not null, trigger text not null,
    created_at integer not null
  );
  create table tool_calls (
    id text primary key, message_id text not null references messages(id) on delete cascade,
    chat_id text not null references chats(id) on delete cascade, name text not null,
    args_json text not null, status text not null, output_blob_hash text,
    output_truncated integer not null default 0, started_at integer, finished_at integer
  );
  create table file_changes (
    id text primary key, project_id text not null references projects(id) on delete cascade,
    chat_id text, candidate_chat_ids text, origin text not null, path text not null,
    before_hash text, after_hash text, tool_call_id text, created_at integer not null,
    reviewed_at integer, reverted_at integer
  );
  create index file_changes_by_path on file_changes(project_id, path, created_at);
  create index file_changes_by_chat on file_changes(chat_id, created_at);
  create table approvals (
    id text primary key, chat_id text not null references chats(id) on delete cascade,
    tool_call_id text not null, kind text not null, summary text not null, flags_json text,
    status text not null default 'pending', decided_at integer
  );
  create table permission_rules (
    id text primary key, project_id text not null references projects(id) on delete cascade,
    tool text not null, pattern text not null, decision text not null
  );
  create table combo_overrides (
    combo text primary key, members_json text, ignored_members_json text, window_override integer
  );
  create table model_windows (
    model_id text primary key, context_window integer not null, source text not null
  );
  `,
  `
  alter table tool_calls add column model_call_id text;
  alter table tool_calls add column output_preview text;
  alter table attachments add column name text not null default '';
  alter table approvals add column project_id text;
  `,
  `
  alter table messages add column kind text not null default 'message';
  `,
  `
  create index if not exists chats_by_parent on chats(parent_chat_id);
  `
]

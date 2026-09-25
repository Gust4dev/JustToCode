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
  `,
  `
  create table chat_groups (
    id text primary key, project_id text not null references projects(id) on delete cascade,
    name text not null, sort_order integer not null default 0,
    collapsed integer not null default 0, created_at integer not null
  );
  create index chat_groups_by_project on chat_groups(project_id, sort_order);
  alter table chats add column group_id text references chat_groups(id) on delete set null;
  alter table chats add column continued_from_chat_id text;
  alter table chats add column max_iterations integer default 50;
  alter table chats add column token_budget integer;
  alter table chats add column settings_json text;
  alter table chats add column last_reported_model text;
  create index chats_by_group on chats(group_id);
  create table queued_messages (
    id text primary key, chat_id text not null references chats(id) on delete cascade,
    text text not null, attachments_json text not null default '[]',
    position integer not null, created_at integer not null
  );
  create index queued_messages_by_chat on queued_messages(chat_id, position);
  create table chat_queue_state (
    chat_id text primary key references chats(id) on delete cascade,
    paused integer not null default 0, pause_reason text
  );
  create table instructions (
    id text primary key, kind text not null, scope text not null, scope_id text,
    name text not null, description text not null default '', trigger text not null,
    globs_json text not null default '[]', body text not null, format text not null default 'md',
    source_json text not null, enabled integer not null default 1, origin_json text,
    created_at integer not null, updated_at integer not null
  );
  create index instructions_by_scope on instructions(scope, scope_id);
  create index instructions_by_kind on instructions(kind);
  create table instruction_toggles (
    instruction_id text primary key, enabled integer not null
  );
  create table chat_touched_paths (
    chat_id text not null references chats(id) on delete cascade, path text not null,
    primary key (chat_id, path)
  );
  `,
  // instructions.scope_id é polimórfico (sem FK): triggers limpam as instruções do escopo
  // apagado. Disparam também nas exclusões em cascata (projeto → chats/grupos, chat → subagentes).
  `
  create trigger instructions_cleanup_project after delete on projects begin
    delete from instructions where scope = 'project' and scope_id = old.id;
  end;
  create trigger instructions_cleanup_group after delete on chat_groups begin
    delete from instructions where scope = 'group' and scope_id = old.id;
  end;
  create trigger instructions_cleanup_chat after delete on chats begin
    delete from instructions where scope = 'chat' and scope_id = old.id;
  end;
  delete from instructions where
    (scope = 'project' and scope_id not in (select id from projects)) or
    (scope = 'group' and scope_id not in (select id from chat_groups)) or
    (scope = 'chat' and scope_id not in (select id from chats));
  `
]

create table if not exists grupos (id text primary key, created_at timestamptz default now());
create table if not exists tareas (
  id bigint generated always as identity primary key,
  chat_id text not null,
  nid int not null,
  materia text not null,
  tipo text not null,
  descripcion text not null,
  fecha_entrega timestamptz not null,
  dificultad text not null,
  horas int default 1,
  creador text,
  avisados int[] default '{}',
  completada boolean default false,
  created_at timestamptz default now(),
  unique(chat_id, nid)
);
alter table grupos enable row level security;
alter table tareas enable row level security;
drop policy if exists "open" on grupos; create policy "open" on grupos for all using (true) with check (true);
drop policy if exists "open" on tareas; create policy "open" on tareas for all using (true) with check (true);

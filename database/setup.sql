-- So Temi launch shoot: database setup. Run once in Supabase > SQL Editor.
-- Every table is locked (row level security on, no policies), so nobody can read
-- or change anything directly. The app only talks to the functions below, and every
-- function checks the private access code first.

create table if not exists access (code text primary key, name text not null, role text not null check (role in ('owner','coord','model','setup')));
create table if not exists state (id text primary key, data jsonb not null default '{}'::jsonb, updated_at timestamptz not null default now());
create table if not exists custom (id text primary key, data jsonb not null, created_at timestamptz not null default now());
create table if not exists images (id text primary key, data text not null);
create table if not exists changes (id bigserial primary key, at timestamptz not null default now(), by text, summary text);
create table if not exists rev (one int primary key default 1 check (one = 1), n bigint not null default 0);
insert into rev (one, n) values (1, 0) on conflict do nothing;

alter table access enable row level security;
alter table state enable row level security;
alter table custom enable row level security;
alter table images enable row level security;
alter table changes enable row level security;
alter table rev enable row level security;
revoke all on access, state, custom, images, changes, rev from anon, authenticated;

-- Add your own people here. Make each code long and random (e.g. 12 letters and numbers),
-- and never commit the real codes to GitHub.
insert into access (code, name, role) values
  ('CHANGE-ME-OWNER', 'Owner', 'owner'),
  ('CHANGE-ME-COORD', 'Coordinator', 'coord'),
  ('CHANGE-ME-MODEL1', 'Model 1', 'model'),
  ('CHANGE-ME-SETUP', 'Setup', 'setup')
on conflict (code) do nothing;

create or replace function st_me(p_code text) returns access
language plpgsql security definer set search_path = public as $$
declare m access;
begin
  select * into m from access where code = upper(p_code);
  if not found then raise exception 'Invalid access code' using errcode = '42501'; end if;
  return m;
end $$;

create or replace function st_bump() returns bigint
language sql security definer set search_path = public as $$
  update rev set n = n + 1 where one = 1 returning n;
$$;

create or replace function st_rev(p_code text) returns bigint
language plpgsql security definer set search_path = public as $$
begin
  perform st_me(p_code);
  return (select n from rev where one = 1);
end $$;

create or replace function st_load(p_code text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare m access;
begin
  m := st_me(p_code);
  if m.role = 'setup' then raise exception 'Setup code only works on the setup page' using errcode = '42501'; end if;
  return jsonb_build_object(
    'me', jsonb_build_object('name', m.name, 'role', m.role),
    'content', (select data from state where id = 'content'),
    'plan', coalesce((select data from state where id = 'plan'), '{}'::jsonb),
    'ticks', coalesce((select data from state where id = 'ticks'), '{}'::jsonb),
    'custom', coalesce((select jsonb_agg(data || jsonb_build_object('id', id) order by created_at) from custom), '[]'::jsonb),
    'changes', coalesce((select jsonb_agg(to_jsonb(c) order by c.id desc) from (select id, at, by, summary from changes order by id desc limit 40) c), '[]'::jsonb),
    'rev', (select n from rev where one = 1));
end $$;

create or replace function st_images(p_code text) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  perform st_me(p_code);
  return coalesce((select jsonb_object_agg(id, data) from images), '{}'::jsonb);
end $$;

create or replace function st_save_plan(p_code text, p_plan jsonb, p_summary text) returns bigint
language plpgsql security definer set search_path = public as $$
declare m access;
begin
  m := st_me(p_code);
  if m.role <> 'owner' then raise exception 'Only the owner can change the plan' using errcode = '42501'; end if;
  insert into state (id, data, updated_at) values ('plan', p_plan, now())
    on conflict (id) do update set data = excluded.data, updated_at = now();
  if p_summary is not null and length(p_summary) > 0 then
    insert into changes (by, summary) values (m.name, left(p_summary, 300));
  end if;
  return st_bump();
end $$;

create or replace function st_add_custom(p_code text, p_id text, p_data jsonb) returns bigint
language plpgsql security definer set search_path = public as $$
declare m access;
begin
  m := st_me(p_code);
  if m.role <> 'owner' then raise exception 'Only the owner can add shots' using errcode = '42501'; end if;
  if length(p_data::text) > 400000 then raise exception 'That photo is too big' using errcode = '22023'; end if;
  insert into custom (id, data) values (p_id, p_data) on conflict (id) do update set data = excluded.data;
  insert into changes (by, summary) values (m.name, 'Added a new shot: ' || coalesce(p_data->>'title', 'New shot'));
  return st_bump();
end $$;

create or replace function st_tick(p_code text, p_kind text, p_key text, p_on boolean) returns bigint
language plpgsql security definer set search_path = public as $$
declare m access; cur jsonb; existing jsonb;
begin
  m := st_me(p_code);
  if m.role = 'setup' then raise exception 'Not allowed' using errcode = '42501'; end if;
  if p_kind not in ('shots','white','props','blocks','ready','help') then raise exception 'Unknown list' using errcode = '22023'; end if;
  if m.role = 'model' and p_kind not in ('shots','white','ready','help') then raise exception 'Only the team can tick that' using errcode = '42501'; end if;
  if m.role = 'model' and p_kind in ('ready','help') and split_part(p_key, '-', 1) <> m.name and p_key <> m.name then
    raise exception 'You can only tick your own list' using errcode = '42501'; end if;
  insert into state (id, data) values ('ticks', '{}'::jsonb) on conflict do nothing;
  select data into cur from state where id = 'ticks' for update;
  existing := cur -> p_kind -> p_key;
  if not p_on and m.role = 'model' and existing is not null and existing->>'by' <> m.name then
    raise exception 'Only the team can undo someone else''s tick' using errcode = '42501'; end if;
  if p_on then
    cur := jsonb_set(cur, array[p_kind], coalesce(cur -> p_kind, '{}'::jsonb) || jsonb_build_object(p_key, jsonb_build_object('by', m.name, 'at', now())));
  else
    cur := cur #- array[p_kind, p_key];
  end if;
  update state set data = cur, updated_at = now() where id = 'ticks';
  return st_bump();
end $$;

-- Used once by the setup page to load the plan and the inspo photos.
create or replace function st_seed(p_code text, p_content jsonb) returns bigint
language plpgsql security definer set search_path = public as $$
declare m access;
begin
  m := st_me(p_code);
  if m.role <> 'setup' then raise exception 'Setup code needed' using errcode = '42501'; end if;
  insert into state (id, data) values ('content', p_content) on conflict (id) do update set data = excluded.data, updated_at = now();
  insert into state (id, data) values ('plan', '{}'::jsonb) on conflict do nothing;
  insert into state (id, data) values ('ticks', '{}'::jsonb) on conflict do nothing;
  return st_bump();
end $$;

create or replace function st_seed_image(p_code text, p_id text, p_data text) returns void
language plpgsql security definer set search_path = public as $$
declare m access;
begin
  m := st_me(p_code);
  if m.role <> 'setup' then raise exception 'Setup code needed' using errcode = '42501'; end if;
  insert into images (id, data) values (p_id, p_data) on conflict (id) do update set data = excluded.data;
end $$;

revoke all on function st_me(text), st_bump() from public, anon, authenticated;
grant execute on function st_rev(text), st_load(text), st_images(text), st_save_plan(text, jsonb, text),
  st_add_custom(text, text, jsonb), st_tick(text, text, text, boolean), st_seed(text, jsonb), st_seed_image(text, text, text) to anon;

-- =============================================================================
-- T2.1  Whiteboard core schema + Row Level Security
-- docs/ARCHITECTURE_SPEC.md §6.  Target: Supabase (PostgreSQL 16).
--
-- Role model: owner > editor > viewer, stored per room in room_members.
-- Writes that change membership or secrets go through SECURITY DEFINER RPCs;
-- tables only expose what RLS allows for the calling auth.uid().
-- =============================================================================

create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------------
-- Types
-- ---------------------------------------------------------------------------
create type public.room_role as enum ('owner', 'editor', 'viewer');
create type public.job_status as enum ('queued', 'processing', 'completed', 'failed');
create type public.inference_backend as enum ('webgpu', 'webgl', 'wasm', 'server-cpu', 'server-cuda');

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
create table public.profiles (
  id            uuid primary key references auth.users (id) on delete cascade,
  display_name  text not null default 'Guest' check (char_length(display_name) between 1 and 60),
  avatar_color  text not null default '#2f4cdd' check (avatar_color ~ '^#[0-9a-fA-F]{6}$'),
  created_at    timestamptz not null default now()
);

create table public.rooms (
  id             uuid primary key default gen_random_uuid(),
  name           text not null check (char_length(btrim(name)) between 1 and 80),
  owner_id       uuid not null references auth.users (id) on delete cascade,
  passcode_hash  text,                                   -- bcrypt; never readable by clients
  has_passcode   boolean generated always as (passcode_hash is not null) stored,
  default_role   public.room_role not null default 'editor'
                 check (default_role in ('editor', 'viewer')),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create table public.room_members (
  room_id    uuid not null references public.rooms (id) on delete cascade,
  user_id    uuid not null references auth.users (id) on delete cascade,
  role       public.room_role not null,
  joined_at  timestamptz not null default now(),
  primary key (room_id, user_id)
);
create index room_members_user_idx on public.room_members (user_id);
-- Exactly one owner row per room.
create unique index room_members_one_owner on public.room_members (room_id) where role = 'owner';

create table public.board_snapshots (
  id          bigint generated always as identity primary key,
  room_id     uuid not null references public.rooms (id) on delete cascade,
  state       bytea not null check (octet_length(state) <= 10 * 1024 * 1024),  -- Y.encodeStateAsUpdate
  created_by  uuid references auth.users (id) on delete set null,
  created_at  timestamptz not null default now()
);
create index board_snapshots_room_latest_idx on public.board_snapshots (room_id, created_at desc);

create table public.board_assets (
  id            uuid primary key default gen_random_uuid(),
  room_id       uuid not null references public.rooms (id) on delete cascade,
  storage_path  text not null unique,                 -- '<room_id>/<asset_id>.<ext>' in bucket board-assets
  width         integer not null check (width > 0),
  height        integer not null check (height > 0),
  mime_type     text not null check (mime_type in ('image/png', 'image/jpeg', 'image/webp')),
  uploaded_by   uuid not null references auth.users (id) on delete cascade,
  created_at    timestamptz not null default now(),
  check (split_part(storage_path, '/', 1) = room_id::text)
);
create index board_assets_room_idx on public.board_assets (room_id);

create table public.style_telemetry (
  id          bigint generated always as identity primary key,
  room_id     uuid references public.rooms (id) on delete set null,
  user_id     uuid not null references auth.users (id) on delete cascade,
  style_id    text not null,
  backend     public.inference_backend not null,
  input_w     integer not null check (input_w > 0),
  input_h     integer not null check (input_h > 0),
  latency_ms  real not null check (latency_ms >= 0),
  fps         real check (fps >= 0),
  psnr        real,
  mae         real,
  lpips       real,
  twe         real,
  created_at  timestamptz not null default now()
);
create index style_telemetry_user_idx on public.style_telemetry (user_id, created_at desc);
create index style_telemetry_style_idx on public.style_telemetry (style_id, backend);

create table public.video_jobs (
  id          text primary key,                      -- Django job_id
  room_id     uuid references public.rooms (id) on delete set null,
  user_id     uuid not null references auth.users (id) on delete cascade,
  style_id    text not null,
  mode        text not null default 'reconet' check (mode in ('reconet', 'per-frame')),
  status      public.job_status not null default 'queued',
  progress    real not null default 0 check (progress between 0 and 100),
  output_url  text,
  error       text,
  metrics     jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index video_jobs_user_idx on public.video_jobs (user_id, created_at desc);

-- ---------------------------------------------------------------------------
-- updated_at maintenance
-- ---------------------------------------------------------------------------
create function public.touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;

create trigger rooms_touch before update on public.rooms
  for each row execute function public.touch_updated_at();
create trigger video_jobs_touch before update on public.video_jobs
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Profile row for every new auth user
-- ---------------------------------------------------------------------------
create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, display_name)
  values (
    new.id,
    coalesce(
      nullif(left(btrim(new.raw_user_meta_data ->> 'display_name'), 60), ''),
      nullif(left(split_part(coalesce(new.email, ''), '@', 1), 60), ''),
      'Guest'
    )
  )
  on conflict (id) do nothing;
  return new;
end $$;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- Role helpers (SECURITY DEFINER so policies can call them without RLS recursion)
-- ---------------------------------------------------------------------------
create function public.room_role_of(p_room_id uuid) returns public.room_role
language sql stable security definer set search_path = '' as $$
  select m.role from public.room_members m
  where m.room_id = p_room_id and m.user_id = (select auth.uid());
$$;

create function public.is_room_member(p_room_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select public.room_role_of(p_room_id) is not null;
$$;

create function public.can_edit_room(p_room_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(public.room_role_of(p_room_id) in ('owner', 'editor'), false);
$$;

create function public.shares_room_with(p_user_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from public.room_members mine
    join public.room_members theirs on theirs.room_id = mine.room_id
    where mine.user_id = (select auth.uid()) and theirs.user_id = p_user_id
  );
$$;

-- ---------------------------------------------------------------------------
-- RPCs
-- ---------------------------------------------------------------------------
create function public.create_room(
  p_name text,
  p_passcode text default null,
  p_default_role public.room_role default 'editor'
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_room uuid;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  if p_default_role = 'owner' then
    raise exception 'invalid_default_role' using errcode = '22023';
  end if;
  if p_passcode is not null and char_length(p_passcode) not between 4 and 64 then
    raise exception 'invalid_passcode_length' using errcode = '22023';
  end if;

  insert into public.rooms (name, owner_id, passcode_hash, default_role)
  values (
    btrim(p_name),
    v_uid,
    case when p_passcode is null then null
         else extensions.crypt(p_passcode, extensions.gen_salt('bf', 10)) end,
    p_default_role
  )
  returning id into v_room;

  insert into public.room_members (room_id, user_id, role) values (v_room, v_uid, 'owner');
  return v_room;
end $$;

create function public.join_room(p_room_id uuid, p_passcode text default null)
returns public.room_role
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_room public.rooms%rowtype;
  v_existing public.room_role;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;

  select * into v_room from public.rooms where id = p_room_id;
  if not found then
    raise exception 'room_not_found' using errcode = 'P0002';
  end if;

  select role into v_existing from public.room_members where room_id = p_room_id and user_id = v_uid;
  if v_existing is not null then
    return v_existing;  -- idempotent: re-joining never changes your role
  end if;

  if v_room.passcode_hash is not null
     and (p_passcode is null or extensions.crypt(p_passcode, v_room.passcode_hash) <> v_room.passcode_hash) then
    raise exception 'invalid_passcode' using errcode = '28P01';
  end if;

  insert into public.room_members (room_id, user_id, role) values (p_room_id, v_uid, v_room.default_role);
  return v_room.default_role;
end $$;

create function public.set_member_role(p_room_id uuid, p_user_id uuid, p_role public.room_role)
returns void
language plpgsql security definer set search_path = '' as $$
begin
  if public.room_role_of(p_room_id) is distinct from 'owner' then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_role = 'owner' then
    raise exception 'ownership_transfer_not_supported' using errcode = '22023';
  end if;
  if p_user_id = auth.uid() then
    raise exception 'owner_cannot_change_own_role' using errcode = '22023';
  end if;

  update public.room_members set role = p_role
  where room_id = p_room_id and user_id = p_user_id;
  if not found then
    raise exception 'member_not_found' using errcode = 'P0002';
  end if;
end $$;

create function public.set_room_passcode(p_room_id uuid, p_passcode text)
returns void
language plpgsql security definer set search_path = '' as $$
begin
  if public.room_role_of(p_room_id) is distinct from 'owner' then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_passcode is not null and char_length(p_passcode) not between 4 and 64 then
    raise exception 'invalid_passcode_length' using errcode = '22023';
  end if;
  update public.rooms
  set passcode_hash = case when p_passcode is null then null
                           else extensions.crypt(p_passcode, extensions.gen_salt('bf', 10)) end
  where id = p_room_id;
end $$;

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
alter table public.profiles        enable row level security;
alter table public.rooms           enable row level security;
alter table public.room_members    enable row level security;
alter table public.board_snapshots enable row level security;
alter table public.board_assets    enable row level security;
alter table public.style_telemetry enable row level security;
alter table public.video_jobs      enable row level security;

-- profiles: yourself + people you share a room with; edit only yourself
create policy profiles_select on public.profiles for select to authenticated
  using (id = (select auth.uid()) or public.shares_room_with(id));
create policy profiles_update on public.profiles for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));

-- rooms: members read; only the owner updates/deletes; creation via create_room()
create policy rooms_select on public.rooms for select to authenticated
  using (public.is_room_member(id));
create policy rooms_update on public.rooms for update to authenticated
  using (public.room_role_of(id) = 'owner') with check (public.room_role_of(id) = 'owner');
create policy rooms_delete on public.rooms for delete to authenticated
  using (public.room_role_of(id) = 'owner');

-- room_members: members see the member list; owner removes others; anyone but the owner may leave
create policy members_select on public.room_members for select to authenticated
  using (public.is_room_member(room_id));
create policy members_delete on public.room_members for delete to authenticated
  using (
    (public.room_role_of(room_id) = 'owner' and user_id <> (select auth.uid()))
    or (user_id = (select auth.uid()) and role <> 'owner')
  );

-- board_snapshots: members read; owner/editor append; owner may prune
create policy snapshots_select on public.board_snapshots for select to authenticated
  using (public.is_room_member(room_id));
create policy snapshots_insert on public.board_snapshots for insert to authenticated
  with check (public.can_edit_room(room_id) and created_by = (select auth.uid()));
create policy snapshots_delete on public.board_snapshots for delete to authenticated
  using (public.room_role_of(room_id) = 'owner');

-- board_assets: members read; owner/editor upload as themselves; uploader or owner deletes
create policy assets_select on public.board_assets for select to authenticated
  using (public.is_room_member(room_id));
create policy assets_insert on public.board_assets for insert to authenticated
  with check (public.can_edit_room(room_id) and uploaded_by = (select auth.uid()));
create policy assets_delete on public.board_assets for delete to authenticated
  using (uploaded_by = (select auth.uid()) or public.room_role_of(room_id) = 'owner');

-- style_telemetry: write and read your own rows; room-tagged rows require membership
create policy telemetry_select on public.style_telemetry for select to authenticated
  using (user_id = (select auth.uid()));
create policy telemetry_insert on public.style_telemetry for insert to authenticated
  with check (user_id = (select auth.uid()) and (room_id is null or public.is_room_member(room_id)));

-- video_jobs: read your own; rows are written by Django with the service role
create policy video_jobs_select on public.video_jobs for select to authenticated
  using (user_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- Grants (defence in depth on top of RLS)
-- ---------------------------------------------------------------------------
revoke all on public.profiles, public.rooms, public.room_members, public.board_snapshots,
  public.board_assets, public.style_telemetry, public.video_jobs from anon;
revoke all on public.profiles, public.rooms, public.room_members, public.board_snapshots,
  public.board_assets, public.style_telemetry, public.video_jobs from authenticated;

grant select, update (display_name, avatar_color) on public.profiles to authenticated;
-- passcode_hash is deliberately excluded from both SELECT and UPDATE.
grant select (id, name, owner_id, has_passcode, default_role, created_at, updated_at) on public.rooms to authenticated;
grant update (name, default_role) on public.rooms to authenticated;
grant delete on public.rooms to authenticated;
grant select, delete on public.room_members to authenticated;
grant select, insert, delete on public.board_snapshots to authenticated;
grant select, insert, delete on public.board_assets to authenticated;
grant select, insert on public.style_telemetry to authenticated;
grant select on public.video_jobs to authenticated;

revoke all on function public.create_room(text, text, public.room_role) from public, anon;
revoke all on function public.join_room(uuid, text) from public, anon;
revoke all on function public.set_member_role(uuid, uuid, public.room_role) from public, anon;
revoke all on function public.set_room_passcode(uuid, text) from public, anon;
grant execute on function public.create_room(text, text, public.room_role) to authenticated;
grant execute on function public.join_room(uuid, text) to authenticated;
grant execute on function public.set_member_role(uuid, uuid, public.room_role) to authenticated;
grant execute on function public.set_room_passcode(uuid, text) to authenticated;

revoke all on function public.room_role_of(uuid) from public, anon;
revoke all on function public.is_room_member(uuid) from public, anon;
revoke all on function public.can_edit_room(uuid) from public, anon;
revoke all on function public.shares_room_with(uuid) from public, anon;
grant execute on function public.room_role_of(uuid) to authenticated;
grant execute on function public.is_room_member(uuid) to authenticated;
grant execute on function public.can_edit_room(uuid) to authenticated;
grant execute on function public.shares_room_with(uuid) to authenticated;

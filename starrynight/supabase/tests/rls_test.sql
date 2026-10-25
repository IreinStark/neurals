-- RLS + RPC behaviour tests for the whiteboard schema (T2.1; feeds TC-E2E-01's "Viewer
-- write mutations are rejected by RLS"). Run with scripts/test-db.sh. Any failed
-- assertion raises and aborts the script (ON_ERROR_STOP).
\set ON_ERROR_STOP on
\set QUIET on

-- ---------------------------------------------------------------- fixtures ---
create schema t;
grant usage on schema t to authenticated;

create function t.ok(cond boolean, msg text) returns void language plpgsql as $$
begin
  if cond is distinct from true then raise exception 'ASSERTION FAILED: %', msg; end if;
end $$;
grant execute on function t.ok(boolean, text) to authenticated;

create function t.login(p_user uuid) returns void language sql as $$
  select set_config('request.jwt.claim.sub', p_user::text, false);
$$;
grant execute on function t.login(uuid) to authenticated;

insert into auth.users (id, email, raw_user_meta_data) values
  ('00000000-0000-0000-0000-00000000000a', 'alice@neu.edu.tr', '{"display_name":"Alice"}'),
  ('00000000-0000-0000-0000-00000000000b', 'bob@neu.edu.tr',   '{}'),
  ('00000000-0000-0000-0000-00000000000c', 'carol@neu.edu.tr', '{}'),
  ('00000000-0000-0000-0000-00000000000d', 'dave@neu.edu.tr',  '{}');

select t.ok((select display_name from public.profiles where id = '00000000-0000-0000-0000-00000000000a') = 'Alice',
            'profile created from metadata');
select t.ok((select display_name from public.profiles where id = '00000000-0000-0000-0000-00000000000b') = 'bob',
            'profile falls back to email local part');

create table t.ids (k text primary key, v uuid);
grant select, insert on t.ids to authenticated;

set role authenticated;

-- ------------------------------------------------------------ create_room ---
select t.login('00000000-0000-0000-0000-00000000000a');
insert into t.ids values
  ('edit_room', public.create_room('Design review', 'starry', 'editor')),
  ('view_room', public.create_room('Defense demo',  null,     'viewer'));

select t.ok(public.room_role_of((select v from t.ids where k = 'edit_room')) = 'owner', 'creator is owner');
select t.ok((select has_passcode from public.rooms where id = (select v from t.ids where k = 'edit_room')), 'has_passcode true');

do $$ begin
  perform passcode_hash from public.rooms;
  raise exception 'ASSERTION FAILED: passcode_hash must not be selectable';
exception when insufficient_privilege then null; end $$;

do $$ begin
  insert into public.rooms (name, owner_id) values ('sneaky', auth.uid());
  raise exception 'ASSERTION FAILED: direct room insert must be denied';
exception when insufficient_privilege then null; end $$;

do $$ begin
  perform public.create_room('x', 'abc');
  raise exception 'ASSERTION FAILED: short passcode accepted';
exception when invalid_parameter_value then null; end $$;

-- -------------------------------------------------------------- join_room ---
select t.login('00000000-0000-0000-0000-00000000000b');
select t.ok(not exists (select 1 from public.rooms), 'non-member sees no rooms');

do $$ begin
  perform public.join_room((select v from t.ids where k = 'edit_room'), 'wrong');
  raise exception 'ASSERTION FAILED: wrong passcode accepted';
exception when invalid_password then null; end $$;

do $$ begin
  perform public.join_room((select v from t.ids where k = 'edit_room'));
  raise exception 'ASSERTION FAILED: missing passcode accepted';
exception when invalid_password then null; end $$;

select t.ok(public.join_room((select v from t.ids where k = 'edit_room'), 'starry') = 'editor', 'bob joins as editor');
select t.ok(public.join_room((select v from t.ids where k = 'edit_room'), 'starry') = 'editor', 'join is idempotent');
select t.ok(public.join_room((select v from t.ids where k = 'view_room')) = 'viewer', 'bob joins open room as viewer');
select t.ok((select count(*) from public.rooms) = 2, 'bob now sees both rooms');
select t.ok((select display_name from public.profiles where id = '00000000-0000-0000-0000-00000000000a') = 'Alice',
            'co-members can read each other''s profile');

select t.login('00000000-0000-0000-0000-00000000000c');
select t.ok(public.join_room((select v from t.ids where k = 'view_room')) = 'viewer', 'carol joins as viewer');
select t.ok(not exists (select 1 from public.profiles where id = '00000000-0000-0000-0000-00000000000d'),
            'cannot read profiles of strangers');

-- ------------------------------------------------- snapshots: viewer vs editor ---
select t.login('00000000-0000-0000-0000-00000000000c');  -- carol, viewer
do $$ begin
  insert into public.board_snapshots (room_id, state, created_by)
  values ((select v from t.ids where k = 'view_room'), '\x01', auth.uid());
  raise exception 'ASSERTION FAILED: viewer wrote a snapshot';
exception when insufficient_privilege then null; end $$;

select t.login('00000000-0000-0000-0000-00000000000b');  -- bob, editor in edit_room
insert into public.board_snapshots (room_id, state, created_by)
values ((select v from t.ids where k = 'edit_room'), '\x0102', auth.uid());

do $$ begin
  insert into public.board_snapshots (room_id, state, created_by)
  values ((select v from t.ids where k = 'edit_room'), '\x01', '00000000-0000-0000-0000-00000000000a');
  raise exception 'ASSERTION FAILED: editor wrote a snapshot as someone else';
exception when insufficient_privilege then null; end $$;

select t.login('00000000-0000-0000-0000-00000000000d');  -- dave, stranger
select t.ok(not exists (select 1 from public.board_snapshots), 'stranger cannot read snapshots');

select t.login('00000000-0000-0000-0000-00000000000c');  -- carol cannot read edit_room snapshots either
select t.ok(not exists (select 1 from public.board_snapshots), 'viewer of another room cannot read snapshots');

-- ------------------------------------------------------- room ownership ---
select t.login('00000000-0000-0000-0000-00000000000b');
update public.rooms set name = 'hijacked' where id = (select v from t.ids where k = 'edit_room');
select t.ok((select name from public.rooms where id = (select v from t.ids where k = 'edit_room')) = 'Design review',
            'editor cannot rename room');

do $$ begin
  perform public.set_member_role((select v from t.ids where k = 'view_room'), '00000000-0000-0000-0000-00000000000c', 'editor');
  raise exception 'ASSERTION FAILED: non-owner changed a role';
exception when insufficient_privilege then null; end $$;

select t.login('00000000-0000-0000-0000-00000000000a');
update public.rooms set name = 'Design review v2' where id = (select v from t.ids where k = 'edit_room');
select t.ok((select name from public.rooms where id = (select v from t.ids where k = 'edit_room')) = 'Design review v2',
            'owner renames room');

select public.set_member_role((select v from t.ids where k = 'view_room'), '00000000-0000-0000-0000-00000000000c', 'editor');
select t.login('00000000-0000-0000-0000-00000000000c');
select t.ok(public.can_edit_room((select v from t.ids where k = 'view_room')), 'promoted viewer can now edit');

select t.login('00000000-0000-0000-0000-00000000000a');
do $$ begin
  perform public.set_member_role((select v from t.ids where k = 'view_room'), auth.uid(), 'viewer');
  raise exception 'ASSERTION FAILED: owner demoted self';
exception when invalid_parameter_value then null; end $$;

-- owner cannot leave (would orphan the room); bob can leave
delete from public.room_members where room_id = (select v from t.ids where k = 'edit_room') and user_id = auth.uid();
select t.ok(public.room_role_of((select v from t.ids where k = 'edit_room')) = 'owner', 'owner cannot leave own room');

select t.login('00000000-0000-0000-0000-00000000000b');
delete from public.room_members where room_id = (select v from t.ids where k = 'view_room') and user_id = auth.uid();
select t.ok(public.room_role_of((select v from t.ids where k = 'view_room')) is null, 'member can leave');

-- passcode rotation by owner
select t.login('00000000-0000-0000-0000-00000000000a');
select public.set_room_passcode((select v from t.ids where k = 'edit_room'), 'night-2027');
select t.login('00000000-0000-0000-0000-00000000000d');
do $$ begin
  perform public.join_room((select v from t.ids where k = 'edit_room'), 'starry');
  raise exception 'ASSERTION FAILED: old passcode still valid';
exception when invalid_password then null; end $$;
select t.ok(public.join_room((select v from t.ids where k = 'edit_room'), 'night-2027') = 'editor', 'new passcode works');

-- ------------------------------------------------------------- telemetry ---
select t.login('00000000-0000-0000-0000-00000000000d');
insert into public.style_telemetry (user_id, style_id, backend, input_w, input_h, latency_ms)
values (auth.uid(), 'starry-night', 'webgl', 512, 384, 41.5);
do $$ begin
  insert into public.style_telemetry (user_id, style_id, backend, input_w, input_h, latency_ms)
  values ('00000000-0000-0000-0000-00000000000a', 'mosaic', 'wasm', 64, 64, 1);
  raise exception 'ASSERTION FAILED: wrote telemetry for another user';
exception when insufficient_privilege then null; end $$;
do $$ begin
  insert into public.style_telemetry (room_id, user_id, style_id, backend, input_w, input_h, latency_ms)
  values ((select v from t.ids where k = 'view_room'), auth.uid(), 'mosaic', 'wasm', 64, 64, 1);
  raise exception 'ASSERTION FAILED: tagged telemetry with a room the user is not in';
exception when insufficient_privilege then null; end $$;
select t.login('00000000-0000-0000-0000-00000000000a');
select t.ok(not exists (select 1 from public.style_telemetry), 'telemetry is private to its author');

-- --------------------------------------------------------------- storage ---
select t.login('00000000-0000-0000-0000-00000000000c');  -- carol: editor in view_room, stranger to edit_room
insert into storage.objects (bucket_id, name, owner_id)
values ('board-assets', (select v from t.ids where k = 'view_room')::text || '/a.png', auth.uid()::text);
do $$ begin
  insert into storage.objects (bucket_id, name, owner_id)
  values ('board-assets', (select v from t.ids where k = 'edit_room')::text || '/b.png', auth.uid()::text);
  raise exception 'ASSERTION FAILED: uploaded into a room the user is not in';
exception when insufficient_privilege then null; end $$;
do $$ begin
  insert into storage.objects (bucket_id, name, owner_id) values ('board-assets', 'not-a-uuid/c.png', auth.uid()::text);
  raise exception 'ASSERTION FAILED: malformed path accepted';
exception when insufficient_privilege then null; end $$;

select t.login('00000000-0000-0000-0000-00000000000d');
select t.ok(not exists (select 1 from storage.objects), 'non-member cannot list room assets');

reset role;
\echo 'RLS tests passed'

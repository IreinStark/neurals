-- =============================================================================
-- T2.1  Storage bucket for canvas image uploads + committed style results.
-- Object path convention: '<room_id>/<asset_id>.<ext>'
-- =============================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('board-assets', 'board-assets', false, 10485760, array['image/png', 'image/jpeg', 'image/webp'])
on conflict (id) do nothing;

-- First path segment as a room id; NULL (=> policy denies) instead of a cast error for malformed paths.
create function public.room_id_from_path(p_name text) returns uuid
language sql immutable set search_path = '' as $$
  select case
    when split_part(p_name, '/', 1) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      then split_part(p_name, '/', 1)::uuid
  end;
$$;
grant execute on function public.room_id_from_path(text) to authenticated;

create policy "board assets: members read" on storage.objects for select to authenticated
  using (
    bucket_id = 'board-assets'
    and public.is_room_member(public.room_id_from_path(name))
  );

create policy "board assets: editors upload" on storage.objects for insert to authenticated
  with check (
    bucket_id = 'board-assets'
    and public.can_edit_room(public.room_id_from_path(name))
  );

create policy "board assets: uploader or owner deletes" on storage.objects for delete to authenticated
  using (
    bucket_id = 'board-assets'
    and (
      owner_id = (select auth.uid())::text
      or public.room_role_of(public.room_id_from_path(name)) = 'owner'
    )
  );

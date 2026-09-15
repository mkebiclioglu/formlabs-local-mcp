-- Create accounts without GoTrue's confirmation email (the project's built-in
-- SMTP is rate limited to a couple of messages per hour). Only the service
-- account may call this; the app then signs the user in with the password.
create or replace function public.create_user_account(p_email text, p_password text) returns uuid
language plpgsql security definer set search_path = public, auth, extensions as $$
declare
  uid uuid := gen_random_uuid();
  em text := lower(trim(p_email));
begin
  if not public.is_service() then
    raise exception 'not allowed';
  end if;
  if em !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'invalid_email';
  end if;
  if length(p_password) < 8 then
    raise exception 'weak_password';
  end if;
  if exists (select 1 from auth.users where email = em) then
    raise exception 'email_exists';
  end if;
  insert into auth.users (
    id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
    confirmation_token, recovery_token, email_change_token_new, email_change, email_change_token_current,
    phone_change, phone_change_token, reauthentication_token, is_sso_user, is_anonymous
  ) values (
    uid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', em,
    crypt(p_password, gen_salt('bf', 10)), now(),
    '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now(),
    '', '', '', '', '', '', '', '', false, false
  );
  insert into auth.identities (id, user_id, provider_id, provider, identity_data, last_sign_in_at, created_at, updated_at)
  values (gen_random_uuid(), uid, uid::text, 'email', jsonb_build_object('sub', uid::text, 'email', em, 'email_verified', true), now(), now(), now());
  return uid;
end;
$$;
revoke all on function public.create_user_account(text, text) from public;
grant execute on function public.create_user_account(text, text) to authenticated;

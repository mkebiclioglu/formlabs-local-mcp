-- Supabase grants EXECUTE on new functions to anon/authenticated by default.
-- Keep the SECURITY DEFINER helpers reachable only where needed.
drop function if exists public.confirm_new_user(uuid);
revoke execute on function public.claim_relay_request(uuid) from anon, public;
revoke execute on function public.create_user_account(text, text) from anon, public;
revoke execute on function public.handle_new_user() from anon, authenticated, public;
revoke execute on function public.is_service() from anon, public;
revoke execute on function public.owns_environment(uuid) from anon, public;

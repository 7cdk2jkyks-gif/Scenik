
-- =========================================================
-- PROFILES
-- =========================================================
CREATE TABLE public.profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  display_name text NOT NULL DEFAULT '',
  bio text NOT NULL DEFAULT '',
  avatar_url text,
  units text NOT NULL DEFAULT 'auto' CHECK (units IN ('auto','mi','km')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.profiles TO anon;
GRANT SELECT, INSERT, UPDATE ON public.profiles TO authenticated;
GRANT ALL ON public.profiles TO service_role;

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Profiles are public to read"
  ON public.profiles FOR SELECT
  USING (true);

CREATE POLICY "Users insert own profile"
  ON public.profiles FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = id);

CREATE POLICY "Users update own profile"
  ON public.profiles FOR UPDATE TO authenticated
  USING (auth.uid() = id) WITH CHECK (auth.uid() = id);

CREATE TRIGGER profiles_updated_at BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Auto-create profile on signup
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (id, display_name)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.raw_user_meta_data->>'name', split_part(NEW.email, '@', 1), 'Traveler')
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- Backfill profiles for any existing users
INSERT INTO public.profiles (id, display_name)
SELECT u.id, COALESCE(u.raw_user_meta_data->>'full_name', split_part(u.email, '@', 1), 'Traveler')
FROM auth.users u
ON CONFLICT (id) DO NOTHING;

-- =========================================================
-- ROUTES: sharing columns
-- =========================================================
ALTER TABLE public.routes
  ADD COLUMN is_public boolean NOT NULL DEFAULT false,
  ADD COLUMN like_count integer NOT NULL DEFAULT 0,
  ADD COLUMN comment_count integer NOT NULL DEFAULT 0;

CREATE INDEX routes_is_public_created_idx ON public.routes (is_public, created_at DESC) WHERE is_public = true;

-- Public read policy (anyone, including anon)
CREATE POLICY "Public routes readable by anyone"
  ON public.routes FOR SELECT
  USING (is_public = true);

GRANT SELECT ON public.routes TO anon;

-- =========================================================
-- ROUTE LIKES
-- =========================================================
CREATE TABLE public.route_likes (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  route_id uuid NOT NULL REFERENCES public.routes(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, route_id)
);

GRANT SELECT ON public.route_likes TO anon;
GRANT SELECT, INSERT, DELETE ON public.route_likes TO authenticated;
GRANT ALL ON public.route_likes TO service_role;

ALTER TABLE public.route_likes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Likes on public routes readable"
  ON public.route_likes FOR SELECT
  USING (EXISTS (SELECT 1 FROM public.routes r WHERE r.id = route_id AND r.is_public = true));

CREATE POLICY "Users insert own likes on public routes"
  ON public.route_likes FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id AND EXISTS (SELECT 1 FROM public.routes r WHERE r.id = route_id AND r.is_public = true));

CREATE POLICY "Users delete own likes"
  ON public.route_likes FOR DELETE TO authenticated
  USING (auth.uid() = user_id);

CREATE OR REPLACE FUNCTION public.route_likes_count_trigger()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE public.routes SET like_count = like_count + 1 WHERE id = NEW.route_id;
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE public.routes SET like_count = GREATEST(0, like_count - 1) WHERE id = OLD.route_id;
    RETURN OLD;
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER route_likes_count_ins
  AFTER INSERT ON public.route_likes
  FOR EACH ROW EXECUTE FUNCTION public.route_likes_count_trigger();

CREATE TRIGGER route_likes_count_del
  AFTER DELETE ON public.route_likes
  FOR EACH ROW EXECUTE FUNCTION public.route_likes_count_trigger();

-- =========================================================
-- ROUTE COMMENTS
-- =========================================================
CREATE TABLE public.route_comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  route_id uuid NOT NULL REFERENCES public.routes(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 1000),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX route_comments_route_idx ON public.route_comments (route_id, created_at DESC);

GRANT SELECT ON public.route_comments TO anon;
GRANT SELECT, INSERT, DELETE ON public.route_comments TO authenticated;
GRANT ALL ON public.route_comments TO service_role;

ALTER TABLE public.route_comments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Comments on public routes readable"
  ON public.route_comments FOR SELECT
  USING (EXISTS (SELECT 1 FROM public.routes r WHERE r.id = route_id AND r.is_public = true));

CREATE POLICY "Users comment on public routes"
  ON public.route_comments FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id AND EXISTS (SELECT 1 FROM public.routes r WHERE r.id = route_id AND r.is_public = true));

CREATE POLICY "Users delete own comments"
  ON public.route_comments FOR DELETE TO authenticated
  USING (auth.uid() = user_id);

CREATE OR REPLACE FUNCTION public.route_comments_count_trigger()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE public.routes SET comment_count = comment_count + 1 WHERE id = NEW.route_id;
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE public.routes SET comment_count = GREATEST(0, comment_count - 1) WHERE id = OLD.route_id;
    RETURN OLD;
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER route_comments_count_ins
  AFTER INSERT ON public.route_comments
  FOR EACH ROW EXECUTE FUNCTION public.route_comments_count_trigger();

CREATE TRIGGER route_comments_count_del
  AFTER DELETE ON public.route_comments
  FOR EACH ROW EXECUTE FUNCTION public.route_comments_count_trigger();

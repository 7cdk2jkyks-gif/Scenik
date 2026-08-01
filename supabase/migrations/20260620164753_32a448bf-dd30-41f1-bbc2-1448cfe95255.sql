
CREATE TABLE public.saved_searches (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  start_address TEXT NOT NULL,
  end_address TEXT NOT NULL,
  mood TEXT NOT NULL DEFAULT '',
  theme TEXT NOT NULL DEFAULT '',
  extra_minutes INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.saved_searches TO authenticated;
GRANT ALL ON public.saved_searches TO service_role;
ALTER TABLE public.saved_searches ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage own searches" ON public.saved_searches
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE INDEX saved_searches_user_created_idx ON public.saved_searches (user_id, created_at DESC);

CREATE TYPE public.road_report_type AS ENUM ('camera', 'closure', 'works', 'hazard');

CREATE TABLE public.road_reports (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  kind public.road_report_type NOT NULL,
  lat DOUBLE PRECISION NOT NULL,
  lng DOUBLE PRECISION NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '7 days'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.road_reports TO authenticated;
GRANT ALL ON public.road_reports TO service_role;
ALTER TABLE public.road_reports ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated can read active reports" ON public.road_reports
  FOR SELECT TO authenticated USING (expires_at > now());
CREATE POLICY "Users insert own reports" ON public.road_reports
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users update own reports" ON public.road_reports
  FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users delete own reports" ON public.road_reports
  FOR DELETE TO authenticated USING (auth.uid() = user_id);
CREATE INDEX road_reports_expires_idx ON public.road_reports (expires_at);
CREATE INDEX road_reports_loc_idx ON public.road_reports (lat, lng);

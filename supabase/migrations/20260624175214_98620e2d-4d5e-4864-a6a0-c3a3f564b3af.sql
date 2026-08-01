
ALTER TABLE public.routes
  ADD COLUMN IF NOT EXISTS rating_avg NUMERIC(3,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS rating_count INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS public.route_ratings (
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  route_id UUID NOT NULL REFERENCES public.routes(id) ON DELETE CASCADE,
  rating SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, route_id)
);

GRANT SELECT ON public.route_ratings TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.route_ratings TO authenticated;
GRANT ALL ON public.route_ratings TO service_role;

ALTER TABLE public.route_ratings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Ratings are readable by anyone"
  ON public.route_ratings FOR SELECT
  USING (true);

CREATE POLICY "Users can insert their own rating"
  ON public.route_ratings FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own rating"
  ON public.route_ratings FOR UPDATE TO authenticated
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete their own rating"
  ON public.route_ratings FOR DELETE TO authenticated
  USING (auth.uid() = user_id);

CREATE OR REPLACE FUNCTION public.route_ratings_aggregate_trigger()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  target_route UUID;
BEGIN
  IF TG_OP = 'DELETE' THEN
    target_route := OLD.route_id;
  ELSE
    target_route := NEW.route_id;
  END IF;

  UPDATE public.routes r
  SET rating_count = sub.cnt,
      rating_avg = COALESCE(sub.avg_val, 0)
  FROM (
    SELECT COUNT(*)::int AS cnt, AVG(rating)::numeric(3,2) AS avg_val
    FROM public.route_ratings
    WHERE route_id = target_route
  ) sub
  WHERE r.id = target_route;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS route_ratings_aggregate ON public.route_ratings;
CREATE TRIGGER route_ratings_aggregate
AFTER INSERT OR UPDATE OR DELETE ON public.route_ratings
FOR EACH ROW EXECUTE FUNCTION public.route_ratings_aggregate_trigger();

CREATE TRIGGER update_route_ratings_updated_at
BEFORE UPDATE ON public.route_ratings
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

import { useEffect, useRef, useState } from "react";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { loadGoogleMaps } from "@/lib/google-maps-loader";

type Suggestion = { id: string; text: string };

export function AddressAutocomplete({
  id,
  label,
  value,
  onChange,
  placeholder,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [open, setOpen] = useState(false);
  const sessionRef = useRef<any>(null);
  const timerRef = useRef<number | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const skipNextFetch = useRef(false);

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  async function fetchSuggestions(input: string) {
    if (!input.trim() || input.trim().length < 2) {
      setSuggestions([]);
      setOpen(false);
      return;
    }
    try {
      await loadGoogleMaps();
      const places = await (window as any).google.maps.importLibrary("places");
      if (!sessionRef.current) sessionRef.current = new places.AutocompleteSessionToken();
      const { suggestions: s } = await places.AutocompleteSuggestion.fetchAutocompleteSuggestions({
        input,
        sessionToken: sessionRef.current,
      });
      const mapped: Suggestion[] = (s ?? [])
        .slice(0, 6)
        .map((sg: any, i: number) => {
          const p = sg.placePrediction;
          return {
            id: p?.placeId ?? `${i}`,
            text: p?.text?.toString?.() ?? "",
          };
        })
        .filter((x: Suggestion) => x.text);
      setSuggestions(mapped);
      setOpen(mapped.length > 0);
    } catch (e) {
      console.error("[autocomplete]", e);
    }
  }

  function onInput(e: React.ChangeEvent<HTMLInputElement>) {
    const v = e.target.value;
    onChange(v);
    if (skipNextFetch.current) {
      skipNextFetch.current = false;
      return;
    }
    if (timerRef.current) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => fetchSuggestions(v), 200);
  }

  function pick(s: Suggestion) {
    skipNextFetch.current = true;
    onChange(s.text);
    setOpen(false);
    setSuggestions([]);
    sessionRef.current = null;
  }

  return (
    <div ref={wrapRef} className="relative">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        value={value}
        onChange={onInput}
        placeholder={placeholder}
        autoComplete="off"
        onFocus={() => suggestions.length > 0 && setOpen(true)}
      />
      {open && suggestions.length > 0 && (
        <ul className="absolute z-30 mt-1 max-h-72 w-full overflow-auto rounded-md border border-border bg-popover shadow-paper">
          {suggestions.map((s) => (
            <li key={s.id}>
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(s)}
                className="block w-full px-3 py-2 text-left text-sm hover:bg-muted"
              >
                {s.text}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

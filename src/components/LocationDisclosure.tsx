import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { MapPin, X } from "lucide-react";

export function LocationDisclosure({
  open,
  onOpenChange,
  onAllow,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAllow: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
            <MapPin className="h-6 w-6 text-primary" />
          </div>
          <DialogTitle className="mt-4 text-center font-serif text-lg">
            Allow location access
          </DialogTitle>
          <DialogDescription className="text-center text-sm">
            Scenik uses your location to provide turn-by-turn navigation and route guidance.
            Your detailed location history is not stored.
          </DialogDescription>
        </DialogHeader>
        <div className="mt-2 flex flex-col gap-2">
          <Button onClick={onAllow}>
            <MapPin className="mr-2 h-4 w-4" /> Allow location access
          </Button>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            <X className="mr-2 h-4 w-4" /> Not now
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

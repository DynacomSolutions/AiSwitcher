import { useMutation, useQueryClient } from "@tanstack/react-query";
import { RotateCcw } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Input } from "@/components/ui/input";
import { qk } from "@/hooks/queries";
import { api } from "@/lib/api";
import { IDENTITY_COLOUR_PALETTE, isValidIdentityColour, normaliseIdentityColour } from "@/lib/colour";
import { cn } from "@/lib/utils";
import type { IdentityDto, ToolName } from "@/types/api";

/**
 * Per-identity session colour picker: palette swatches (the server's shared
 * auto-assign palette), a custom hex input, and reset-to-auto. PATCHes
 * `colour` and invalidates the identities + tree queries so every surface
 * (identity list, sessions tree, chats) re-tints.
 */
export function IdentityColourPicker({
  tool,
  identity,
  children,
  align = "start",
}: {
  tool: ToolName;
  identity: IdentityDto;
  children: ReactNode;
  align?: "start" | "center" | "end";
}) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [hex, setHex] = useState(identity.colour ?? identity.effectiveColour ?? "");
  const effective = identity.effectiveColour || "#71717a";
  const explicit = identity.colour;

  useEffect(() => {
    if (open) setHex(identity.colour ?? "");
  }, [open, identity.colour]);

  const mutation = useMutation({
    mutationFn: (colour: string) => api.patchIdentity(tool, identity.name, { colour }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.identities });
      void qc.invalidateQueries({ queryKey: ["sessions", "tree"] });
      toast.success("Colour updated", { description: `${tool}/${identity.name}` });
      setOpen(false);
    },
    onError: (error) => toast.error("Colour update failed", { description: error.message }),
  });

  const submitHex = () => {
    const value = hex.trim();
    if (!isValidIdentityColour(value) || mutation.isPending) return;
    mutation.mutate(value);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent align={align} className="w-64 space-y-3">
        <div className="space-y-1">
          <p className="text-sm font-medium">Session colour</p>
          <p className="text-xs text-muted-foreground">
            {tool}/{identity.name}
            {explicit ? (
              <>
                {" "}
                · explicit <span className="font-mono">{explicit}</span>
              </>
            ) : (
              " · auto-assigned"
            )}
          </p>
        </div>

        <div className="grid grid-cols-8 gap-1.5">
          {IDENTITY_COLOUR_PALETTE.map((colour) => (
            <button
              key={colour}
              type="button"
              aria-label={`Set colour ${colour}`}
              disabled={mutation.isPending}
              onClick={() => mutation.mutate(colour)}
              className={cn(
                "size-5 rounded-full border transition-transform hover:scale-110",
                colour === effective ? "border-foreground ring-2 ring-ring/60" : "border-border",
              )}
              style={{ backgroundColor: colour }}
            />
          ))}
        </div>

        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            submitHex();
          }}
        >
          <Input
            className="h-8 font-mono text-xs"
            placeholder="#22c55e"
            value={hex}
            onChange={(e) => setHex(e.target.value)}
            spellCheck={false}
            aria-label="Custom hex colour"
          />
          <Button type="submit" size="sm" disabled={!isValidIdentityColour(hex.trim()) || mutation.isPending}>
            Set
          </Button>
        </form>

        <Button
          variant="outline"
          size="sm"
          className="w-full"
          disabled={!explicit || mutation.isPending}
          onClick={() => mutation.mutate("")}
        >
          <RotateCcw aria-hidden />
          Reset to auto
        </Button>
        <p className="text-center font-mono text-[10px] text-muted-foreground" title={effective}>
          effective {normaliseIdentityColour(effective) ?? effective}
        </p>
      </PopoverContent>
    </Popover>
  );
}

import { ScrollText } from "lucide-react";
import { Link } from "react-router-dom";

import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { resetLogPath } from "@/lib/reset-log";
import { cn } from "@/lib/utils";

/** A small icon link from an identity to its reset log. A real link, so a middle click opens it in a new tab. */
export function ResetLogLink({ identity, className }: { identity: string; className?: string }) {
  const label = `Reset log for ${identity}`;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button asChild variant="outline" size="sm" className={cn("size-7 shrink-0 p-0", className)}>
          <Link to={resetLogPath(identity)} aria-label={label}>
            <ScrollText aria-hidden className="size-3.5" />
          </Link>
        </Button>
      </TooltipTrigger>
      <TooltipContent>Reset log</TooltipContent>
    </Tooltip>
  );
}

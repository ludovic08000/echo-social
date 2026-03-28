import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap text-sm font-semibold ring-offset-background transition-all duration-300 ease-[cubic-bezier(0.23,1,0.32,1)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 active:scale-[0.96] relative overflow-hidden select-none",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground rounded-2xl shadow-[0_2px_12px_hsl(var(--primary)/0.3)] hover:shadow-[0_6px_24px_hsl(var(--primary)/0.4)] hover:-translate-y-1 hover:brightness-110 before:absolute before:inset-0 before:rounded-2xl before:bg-gradient-to-b before:from-white/[0.15] before:to-transparent before:pointer-events-none",
        destructive: "bg-destructive text-destructive-foreground rounded-2xl shadow-[0_2px_12px_hsl(var(--destructive)/0.3)] hover:shadow-[0_6px_24px_hsl(var(--destructive)/0.4)] hover:-translate-y-1 hover:brightness-110 before:absolute before:inset-0 before:rounded-2xl before:bg-gradient-to-b before:from-white/[0.15] before:to-transparent before:pointer-events-none",
        outline: "border border-border/40 bg-background/60 backdrop-blur-md text-foreground hover:bg-accent/50 hover:text-accent-foreground rounded-2xl hover:border-primary/40 hover:shadow-[0_4px_20px_hsl(var(--primary)/0.12)] hover:-translate-y-0.5",
        secondary: "bg-secondary/80 backdrop-blur-sm text-secondary-foreground rounded-2xl hover:bg-secondary hover:shadow-[0_4px_16px_hsl(var(--primary)/0.08)] hover:-translate-y-0.5 border border-border/20",
        ghost: "hover:bg-accent/60 hover:text-accent-foreground rounded-2xl hover:backdrop-blur-sm",
        link: "text-primary underline-offset-4 hover:underline decoration-primary/40 hover:decoration-primary/80",
        premium: "bg-[image:var(--premium-gradient)] text-primary-foreground rounded-2xl shadow-[var(--shadow-gold)] hover:shadow-[var(--shadow-glow)] hover:-translate-y-1 hover:scale-[1.03] before:absolute before:inset-0 before:rounded-2xl before:bg-gradient-to-b before:from-white/20 before:to-transparent before:pointer-events-none",
      },
      size: {
        default: "h-10 px-5 py-2",
        sm: "h-9 rounded-2xl px-4 text-xs",
        lg: "h-12 rounded-2xl px-8 text-base tracking-wide",
        icon: "h-10 w-10 rounded-2xl",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />;
  },
);
Button.displayName = "Button";

export { Button, buttonVariants };

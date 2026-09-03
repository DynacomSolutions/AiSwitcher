import { Toaster as Sonner } from "sonner";

/** App-wide toast host: dark themed to match the console's default look. */
function Toaster() {
  return (
    <Sonner
      theme="dark"
      position="bottom-right"
      richColors
      closeButton
      toastOptions={{
        classNames: {
          toast: "rounded-xl",
        },
      }}
    />
  );
}

export { Toaster };

<script lang="ts">
  import Sun from "lucide-svelte/icons/sun";
  import Moon from "lucide-svelte/icons/moon";
  import Monitor from "lucide-svelte/icons/monitor";
  import Check from "lucide-svelte/icons/check";
  import * as DropdownMenu from "$lib/components/ui/dropdown-menu";
  import { buttonVariants } from "$lib/components/ui/button";
  import { app, type Theme } from "$lib/state.svelte";
  import { cn } from "$lib/utils";

  const options: { value: Theme; label: string; icon: typeof Sun }[] = [
    { value: "system", label: "System", icon: Monitor },
    { value: "light", label: "Light", icon: Sun },
    { value: "dark", label: "Dark", icon: Moon },
  ];
</script>

<DropdownMenu.Root>
  <DropdownMenu.Trigger
    class={cn(buttonVariants({ variant: "outline", size: "icon" }), "relative")}
    aria-label="Theme"
  >
    <Sun class="h-4 w-4 scale-100 transition-all dark:scale-0" />
    <Moon class="absolute h-4 w-4 scale-0 transition-all dark:scale-100" />
  </DropdownMenu.Trigger>
  <DropdownMenu.Content align="end">
    {#each options as opt (opt.value)}
      <DropdownMenu.Item onSelect={() => app.setTheme(opt.value)}>
        <opt.icon class="size-4" />
        <span class="flex-1">{opt.label}</span>
        {#if app.theme === opt.value}
          <Check class="size-4" />
        {/if}
      </DropdownMenu.Item>
    {/each}
  </DropdownMenu.Content>
</DropdownMenu.Root>

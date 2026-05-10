<script lang="ts">
  import * as DropdownMenu from "$lib/components/ui/dropdown-menu";
  import { Button } from "$lib/components/ui/button";
  import { app } from "$lib/state.svelte";
  import * as auth from "$lib/auth.js";
  import LogOut from "lucide-svelte/icons/log-out";

  let avatarSrc = $state("");
  let displayName = $derived.by(() => {
    const u = app.user;
    return u?.name || u?.email || "Account";
  });

  $effect(() => {
    const u = app.user;
    if (!u) {
      avatarSrc = "";
      return;
    }
    if (u.picture) {
      avatarSrc = u.picture;
      return;
    }
    const seed = u.sub || u.name || u.email || "anon";
    auth.identiconDataUrl(seed).then((src: string) => {
      if (app.user) avatarSrc = src;
    });
  });
</script>

{#if app.authConfig}
  {#if !app.authReady}
    <!-- waiting for auth bootstrap -->
  {:else if !app.user}
    <Button variant="outline" size="sm" onclick={() => auth.login()}>
      Sign in
    </Button>
  {:else}
    <DropdownMenu.Root>
      <DropdownMenu.Trigger
        class="size-8 cursor-pointer overflow-hidden rounded-full border-2 border-border bg-background transition-colors hover:border-foreground/40 focus-visible:border-ring focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        aria-label={displayName}
        title={displayName}
      >
        {#if avatarSrc}
          <img src={avatarSrc} alt="" class="block h-full w-full" />
        {/if}
      </DropdownMenu.Trigger>
      <DropdownMenu.Content align="end" class="min-w-44">
        <DropdownMenu.Group>
          <DropdownMenu.Label>
            <div class="flex flex-col">
              <span class="truncate font-medium">{app.user.name ?? "Account"}</span>
              {#if app.user.email}
                <span class="text-muted-foreground truncate text-xs font-normal">
                  {app.user.email}
                </span>
              {/if}
            </div>
          </DropdownMenu.Label>
        </DropdownMenu.Group>
        <DropdownMenu.Separator />
        <DropdownMenu.Item onSelect={() => auth.logout()}>
          <LogOut class="size-4" />
          Logout
        </DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  {/if}
{/if}

export const STORAGE_DOC = "zorto:doc";
export const STORAGE_TITLE = "zorto:title";
export const STORAGE_THEME = "theme";

export function loadStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function saveStorage(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* quota or unavailable */
  }
}

export type Theme = "system" | "light" | "dark";

export interface EditorAPI {
  getDoc(): string;
  setDoc(text: string, opts?: { fromShare?: boolean }): void;
  focus(): void;
  setLineWrap(enabled: boolean): void;
  requestMeasure(): void;
}

export interface AuthConfig {
  domain: string;
  clientId: string;
  audience: string;
}

export interface SignedInUser {
  name?: string;
  email?: string;
  picture?: string;
  sub?: string;
}

function readTheme(): Theme {
  const v = loadStorage(STORAGE_THEME);
  return v === "light" || v === "dark" || v === "system" ? v : "system";
}

class AppState {
  title = $state<string>(loadStorage(STORAGE_TITLE) ?? "");
  initialDoc: string = loadStorage(STORAGE_DOC) ?? "";
  linkedToShare = $state<boolean>(false);
  theme = $state<Theme>(readTheme());
  previewVisible = $state<boolean>(false);
  wrapEnabled = $state<boolean>(true);
  shareEnabled = $state<boolean>(false);
  authConfig = $state<AuthConfig | null>(null);
  user = $state<SignedInUser | null>(null);
  authReady = $state<boolean>(false);

  editor: EditorAPI | null = null;

  setEditor(api: EditorAPI) {
    this.editor = api;
  }

  setTheme(next: Theme) {
    this.theme = next;
    saveStorage(STORAGE_THEME, next);
  }

  setTitle(next: string) {
    if (this.linkedToShare) this.forkFromShare();
    this.title = next;
    saveStorage(STORAGE_TITLE, next);
  }

  forkFromShare() {
    if (!this.linkedToShare) return;
    this.linkedToShare = false;
    history.replaceState(null, "", location.pathname + location.search);
    saveStorage(STORAGE_TITLE, this.title);
    if (this.editor) saveStorage(STORAGE_DOC, this.editor.getDoc());
  }

  clear() {
    this.linkedToShare = false;
    this.title = "";
    saveStorage(STORAGE_TITLE, "");
    this.editor?.setDoc("");
    saveStorage(STORAGE_DOC, "");
    history.replaceState(null, "", location.pathname + location.search);
  }
}

export const app = new AppState();

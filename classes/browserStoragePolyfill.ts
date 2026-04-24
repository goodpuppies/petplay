type StorageArea = {
  readonly length: number;
  clear(): void;
  getItem(key: string): string | null;
  key(index: number): string | null;
  removeItem(key: string): void;
  setItem(key: string, value: string): void;
};

function createMemoryStorage(): StorageArea {
  const values = new Map<string, string>();

  return {
    get length() {
      return values.size;
    },
    clear() {
      values.clear();
    },
    getItem(key: string) {
      return values.get(String(key)) ?? null;
    },
    key(index: number) {
      return Array.from(values.keys())[index] ?? null;
    },
    removeItem(key: string) {
      values.delete(String(key));
    },
    setItem(key: string, value: string) {
      values.set(String(key), String(value));
    },
  };
}

function installStorage(name: "localStorage" | "sessionStorage") {
  if (name in globalThis) {
    return;
  }

  Object.defineProperty(globalThis, name, {
    configurable: true,
    enumerable: true,
    value: createMemoryStorage(),
    writable: false,
  });
}

installStorage("localStorage");
installStorage("sessionStorage");

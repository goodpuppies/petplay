import { LogChannel } from "@mommysgoodpuppy/logchannel";

type MainStdinActions = {
  spawnOverlay: (name: string) => void;
  inspect: () => void;
  logInput?: (input: string) => void;
};

export class MainStdinHandler {
  constructor(private readonly actions: MainStdinActions) {}

  handle(rawInput: string) {
    const input = rawInput.trim();

    if (!input.startsWith("/")) {
      this.actions.logInput?.(rawInput);
      return;
    }

    const parts = input.split(" ");
    const command = parts[0].toLowerCase();

    switch (command) {
      case "/spawn": {
        if (parts.length < 3) {
          LogChannel.log("error", "Usage: /spawn [type] [name]");
          return;
        }

        const spawnType = parts[1];
        const spawnName = parts[2];

        if (spawnType !== "overlay") {
          LogChannel.log("error", `Unknown spawn type: ${spawnType}`);
          return;
        }

        this.actions.spawnOverlay(spawnName);
        LogChannel.log("actor", `Spawning overlay: ${spawnName}`);
        return;
      }
      case "/inspect":
        this.actions.inspect();
        return;
      default:
        LogChannel.log("error", `Unknown command: ${command}`);
    }
  }
}

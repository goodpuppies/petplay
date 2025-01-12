export const CustomLogger = (() => {
    let activeChannels: string[] = ["default", "postman", "overlay", "perf", "origin"]; // Initialize with default channel
    const setChannel = (channel: string | string[]) => {
        if (Array.isArray(channel)) {
            activeChannels = channel;
        } else {
            activeChannels = [channel];
        }
    };

    const log = (channelOrMessage: string, ...messages: unknown[]) => {

        if (typeof channelOrMessage === 'string' && messages.length > 0) {
            // A channel was specified
            if (activeChannels.includes(channelOrMessage)) {
                console.log(`${channelOrMessage.toUpperCase()}:`, ...messages);
            }
        } else {
            // No channel specified, use active channels
            if (activeChannels.includes("default")) {
                console.log(channelOrMessage, ...messages);
            }
        }
    };

    const error = (channelOrMessage: string, ...messages: unknown[]) => {
        if (typeof channelOrMessage === 'string' && messages.length > 0) {
            // A channel was specified
            if (activeChannels.includes(channelOrMessage)) {
                
                console.error(...messages);
            }
        } else {
            // No channel specified, use active channels
            if (activeChannels.includes("default")) {
                console.error(channelOrMessage, ...messages);
            }
        }
    };

    return {
        setChannel,
        log,
        error
    }
})();
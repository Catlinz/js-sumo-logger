const DEFAULT_INTERVAL = 0;
const DEFAULT_BATCH = 0;
const NOOP = () => {};

function getUUID(): string {
    // eslint gets funny about bitwise
    /* eslint-disable */
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const piece = (Math.random() * 16) | 0;
        const elem = c === 'x' ? piece : (piece & 0x3) | 0x8;
        return elem.toString(16);
    });
    /* eslint-enable */
}

class SumoLogger {
    private config: SumoLoggerConfig = {} as SumoLoggerConfig;
    private interval: number|NodeJS.Timer = 0;
    private logSending = false;
    private pendingLogs: (string|object)[] = [];

    constructor(options: SumoLoggerOptions) {
        if (!options || !options.endpoint || !isString(options.endpoint)) {
            console.error('An endpoint value must be provided');
            return;
        }

        this.setConfig(options);
        this.startLogSending();
    }

    setConfig(newConfig: SumoLoggerOptions) {
        this.config = {
            endpoint: newConfig.endpoint,
            returnPromise: isDefinedNotNull(newConfig.returnPromise) ? newConfig.returnPromise : true,
            clientUrl: newConfig.clientUrl || STR_EMPTY,
            useIntervalOnly: newConfig.useIntervalOnly || false,
            interval: newConfig.interval || DEFAULT_INTERVAL,
            batchSize: newConfig.batchSize || DEFAULT_BATCH,
            sourceName: newConfig.sourceName || STR_EMPTY,
            hostName: newConfig.hostName || STR_EMPTY,
            sourceCategory: newConfig.sourceCategory || STR_EMPTY,
            sessionKey: newConfig.sessionKey || getUUID(),
            onSuccess: newConfig.onSuccess || NOOP,
            onError: newConfig.onError || NOOP,
            graphite: newConfig.graphite || false,
            raw: newConfig.raw || false
        };
    }

    updateConfig(newConfig: Partial<SumoLoggerOptions> = {}) {
        if (newConfig.batchSize) { this.config.batchSize = newConfig.batchSize; }
        if (newConfig.endpoint) { this.config.endpoint = newConfig.endpoint; }
        if (newConfig.returnPromise) { this.config.returnPromise = newConfig.returnPromise; }
        if (newConfig.sourceCategory) { this.config.sourceCategory = newConfig.sourceCategory; }
        if (newConfig.useIntervalOnly) { this.config.useIntervalOnly = newConfig.useIntervalOnly; }
        
        if (newConfig.interval) {
            this.config.interval = newConfig.interval;
            this.startLogSending();
        }
    }

    batchReadyToSend() {
        if (this.config.batchSize === 0) {
            return this.config.interval === 0;
        } else {
            const pendingMessages = this.pendingLogs.reduce((acc: string, curr) => {
                const log = isString(curr) ? JSON.parse(curr) : curr;
                return acc + log.msg + STR_NEWLINE;
            }, STR_EMPTY) as string;
            
            const ready = pendingMessages.length >= this.config.batchSize;
            if (ready) { this.stopLogSending(); }

            return ready;
        }
    }

    _postSuccess(logsSentLength: number) {
        this.pendingLogs = this.pendingLogs.slice(logsSentLength);
        this.logSending = false;
        // Reset interval if needed:
        this.startLogSending();
        this.config.onSuccess();
    }

    async sendLogs(): Promise<Response|false> {
        if (this.logSending || this.pendingLogs.length === 0) { return false; }

        try {
            this.logSending = true;
            const headers: {[header: string]: string} = { 
                'X-Sumo-Client': 'sumo-javascript-sdk',
                'Content-Type': this.config.graphite ? 'application/vnd.sumologic.graphite' : 'application/json',
            };

            if (this.config.sourceName) {
                headers['X-Sumo-Name'] = this.config.sourceName;
            }
            if (this.config.sourceCategory) {
                headers['X-Sumo-Category'] = this.config.sourceCategory;
            }
            if (this.config.hostName) {
                headers['X-Sumo-Host'] = this.config.hostName;
            }

            const logsToSend = this.pendingLogs.length === 1 ? this.pendingLogs : this.pendingLogs.slice();
            const numberOfLogs = logsToSend.length;

            const response = await makeRequest({
                url: this.config.endpoint,
                headers, 
                body: this.pendingLogs.join(STR_NEWLINE)
            });

            this._postSuccess(numberOfLogs);
            return response;

        } catch (error) {
            this.config.onError(error as Error);
            return false;
        }
        finally {
            this.logSending = false;
        }
    }

    startLogSending() {
        if (this.config.interval > 0) {
            if (this.interval) { this.stopLogSending(); }

            this.interval = setInterval(() => this.sendLogs(), this.config.interval);
        }
    }

    stopLogSending() {
        clearInterval(this.interval as NodeJS.Timer);
        this.interval = 0;
    }

    emptyLogQueue() {
        this.pendingLogs = [];
    }

    flushLogs() {
        return this.sendLogs();
    }

    public log(message: string|string[], options?: PerMessageOptions): boolean|Promise<Response|false>;
    public log(message: GraphiteMessage|GraphiteMessage[], options?: PerMessageOptions): boolean|Promise<Response|false>;
    public log<T extends object>(message: T|T[], options?: PerMessageOptions): boolean|Promise<Response|false>;
    public log<T extends object>(message: T|T[]|GraphiteMessage|GraphiteMessage[]|string|string[], optionalConfig?: PerMessageOptions): boolean|Promise<Response|false> {
        if (!message) {
            console.error('A value must be provided');
            return false;
        }

        const testEl = Array.isArray(message) ? message[0] : message;

        if (typeof testEl === TYPE_UNDEFINED) {
            console.error('A value must be provided');
            return false;
        }

        if (this.config.graphite && (!testEl || !isDefinedNotNull((testEl as GraphiteMessage).path) || !isDefinedNotNull((testEl as GraphiteMessage).value))) {
            console.error('Both "path" and "value" properties must be provided in the message object to send Graphite metrics');
            return false;
        }

        if (isObject(testEl)) {
            if (isEmpty(message)) {
                console.error('A non-empty JSON object must be provided');
                return false;
            }
        }

        if (!Array.isArray(message)) {
            message = [message] as T[]|string[];
        }

        let ts = optionalConfig?.timestamp || new Date();
        let sessKey = optionalConfig?.sessionKey || this.config.sessionKey;
        const client = { url: optionalConfig?.url || this.config.clientUrl };

        const timestamp = ts.toJSON();

        const messages = (message as T[]).map((item: T|GraphiteMessage|string): string|T => {
            if (this.config.graphite) {
                return toString((item as GraphiteMessage).path) + STR_SPACE + toString((item as GraphiteMessage).value) + STR_SPACE + Math.round(ts.getTime() / 1000).toString(10);
            }
            if (this.config.raw) {
                return item as T;
            }
            if (isString(item)) {
                return JSON.stringify(
                    Object.assign(
                        {
                            msg: item,
                            sessionId: sessKey,
                            timestamp
                        },
                        client
                    )
                );
            }

            return JSON.stringify(Object.assign({ sessionId: sessKey, timestamp }, client, item));
        });

        this.pendingLogs = this.pendingLogs.concat(messages);

        if (!this.config.useIntervalOnly && this.batchReadyToSend()) {
            return this.sendLogs();
        }

        return true;
    }
}

/*************************************************************/
//#region Utility Functions and Constants
/*************************************************************/

function isDefinedNotNull<T>(value: T|undefined): value is Exclude<T, null|undefined> { return (typeof value !== TYPE_UNDEFINED) && value !== null; }
function isFunction<T extends AnyFunction = AnyFunction>(value: any): value is T { return typeof value === TYPE_FUNCTION; }
function isObject<T extends object = object>(value: any): value is T { return typeof value === TYPE_OBJECT; }
function isString(value: any): value is string { return typeof value === TYPE_STRING; }

function isEmpty<T extends object = never>(value: string|Array<any>|T): boolean {
    if (isString(value) || Array.isArray(value)) { return value.length === 0; }
    return Object.keys(value).length === 0;
}

function toString(value: any): string {
    if (isString(value)) { return value; }
    if (isDefinedNotNull(value) && isFunction(value.toString)) { return value.toString(); }
    return JSON.stringify(value);
}

const TYPE_STRING = 'string';
const TYPE_UNDEFINED = 'undefined';
const TYPE_OBJECT = 'object';
const TYPE_FUNCTION = 'function';

const STR_EMPTY = '';
const STR_NEWLINE = '\n';
const STR_SPACE = ' ';

//#endregion

/*************************************************************/
//#region Request Functions
/*************************************************************/

async function makeRequest(config: RequestConfig): Promise<Response> {
    if (isDefinedNotNull(window) && isDefinedNotNull(window.fetch)) { return makeFetchRequest(config); }
    else { return makeNodeRequest(config); }
}

async function makeNodeRequest(config: RequestConfig): Promise<Response> {
    return new Promise<Response>((resolve, reject) => {
        import('http').then(net => {
            const request = net.request({href: config.url, method: 'POST', headers: config.headers});

            request.once('response', response => {
                let data: string|Buffer;
                response.on('data', chunk => {
                    data = appendChunk(data, chunk);
                });
    
                response.once('error', reject);
                response.once('end', () => {
                    if (!isString(data)) { data = data.toString('utf8'); }
    
                    let json: object|undefined;
                    try { json = JSON.parse(data); }
                    catch(e) { /* Ignore */ }
    
                    resolve({
                        data: json || data,
                        headers: response.headers,
                        status: response.statusCode || 0,
                        statusText: response.statusMessage || STR_EMPTY,
                        
                    });
                });
            });

            request.once('error', reject);
            request.write(config.body, 'utf8');
            request.end();
        });
    });
}

async function makeFetchRequest(config: RequestConfig): Promise<Response> {
    const response = await fetch(config.url, {
        method: 'POST',
        mode: 'cors',
        headers: config.headers, body: config.body,
    });

    const headers: Response['headers'] = {};
    response.headers.forEach((value, key) => { headers[key] = value; });

    return {
        status: response.status,
        statusText: response.statusText,
        headers,
        data: await response.json().catch(_ => ({})),
    };
}

function appendChunk(data: string|Buffer|undefined, chunk: string|Buffer): string|Buffer {
    if (!data) { return chunk; }
    if (isString(chunk)) { return (data as string) + chunk; }
    
    return Buffer.concat([data as Buffer, chunk], data.length + chunk.length);
}

//#endregion

/*************************************************************/
//#region Type Definitions
/*************************************************************/

export interface SumoLoggerOptions {
    /**
     * To send your logs, the script must know which HTTP Source to use. 
     * Pass this value (which you can get from the Collectors page) in the endpoint parameter.
     */
    endpoint: string;

    /**
     * Default: TRUE. Causes log() to return a promise and ignore the 
     * onSuccess and onError handler options (if passed). ONLY works when logs are sent 
     * individually and not batched (interval: 0).
     */
    returnPromise?: boolean;

    /**
     * A number of milliseconds. Messages will be batched and sent at 
     * the interval specified. Default value is zero, meaning messages 
     * are sent each time log() is called. If both batchSize and interval 
     * are configured sending will be triggered when the pending logs' 
     * aggregate message length is reached or when the specified interval is 
     * hit, and in either case the interval will be reset on send.
     */
    interval?: number;

    /**
     * If enabled batchSize is ignored and only interval is used to trigger when the pending logs will be sent.
     */
    useIntervalOnly?: boolean;

    /**
     * An integer specifying total log length. This can be used by itself or in 
     * addition to interval but is ignored when useIntervalOnly is true. For higher 
     * volume applications, Sumo Logic recommends using between 100000 and 1000000 to optimize the 
     * tradeoff between network calls and load. If both batchSize and interval are configured 
     * sending will be triggered when the pending logs' aggregate message length is reached or
     * when the specified interval is hit, and in either case the interval will be reset on send.
     */
    batchSize?: number;

    /**
     * You can provide a function that is executed only when logs are successfully sent.
     * The only information you can be sure of in the callback is that the call succeeded.
     * There is no other response information.
     */
    onSuccess?(): void;

    /**
     * You can provide a function that is executed if an error
     * occurs when the logs are sent.
     */
    onError?(error?: Error): void;

    /**
     * Enables sending raw text logs exactly as they are passed to the logger.
     */
    raw?: boolean;

    /**
     * You can provide a URL, in the Node version of this SDK only, 
     * which will be sent as the url field of the log line. In the '
     * vanilla JS version, the URL is detected from the browser's window.location value.
     */
    clientUrl?: string;

    /** To identify specific user sessions, set a value for this field. */
    sessionKey?: string;

    /**
     * This value identifies the host from which the log is being sent.
     */
    hostName?: string;

    /**
     * This value sets the Source Category for the logged message.
     */
    sourceCategory?: string;

    /**
     * This value sets the Source Name for the logged message.
     */
    sourceName?: string;

    /**
     * This value enabled and disables sending data as graphite metrics
     */
    graphite?: boolean;
}

type SumoLoggerConfig = Required<SumoLoggerOptions>;

export interface PerMessageOptions {
    /**
     * Defaults to `new Date()` called when processing the log call.
     * Use this when the event being logged occurred
     * at a different time than when the log was sent.
     */
    timestamp?: Date;

    /** Override a session key set in the `config` call. */
    sessionKey?: string;

    /** Override client URL set in the config call. (Node version only) */
    url?: string;
}

interface GraphiteMessage {
    path: string;
    value: string|number|boolean;
}

interface Response {
    data: any;
    status: number;
    statusText: string;
    headers: {[header: string]: string | string[] | undefined},
}

type AnyFunction = (...args: any[]) => any;

interface RequestConfig {
    url: string;
    headers: {[header: string]: string};
    body: string;
}

//#endregion

module.exports = SumoLogger;

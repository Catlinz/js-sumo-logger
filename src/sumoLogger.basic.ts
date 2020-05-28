class SumoLogger {
    private _config: SumoLoggerConfig = {} as SumoLoggerConfig;
    private _endpoint: string;
    private _logSending = false;
    private _logsToSend?: string[];
    private _pendingLogs: string[] = [];

    constructor(options: SumoLoggerOptions) {
        if (!options || !options.endpoint || !isString(options.endpoint)) {
            console.error('An endpoint value must be provided');
            return;
        }

        this._endpoint = options.endpoint;

        this._config = {
            clientUrl: options.clientUrl ?? STR_EMPTY,
            sourceName: options.sourceName ?? STR_EMPTY,
            hostName: options.hostName ?? STR_EMPTY,
            sourceCategory: options.sourceCategory ?? STR_EMPTY,
            // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
            sessionKey: options.sessionKey || getUUID(),
        };
    }

    public emptyLogQueue() { this._pendingLogs = []; }

    public async flushLogs(): Promise<Response|false> {
        if (this._logSending || (!this._logsToSend && this._pendingLogs.length === 0)) { return false; }

        try {
            this._logSending = true;
            const headers: {[header: string]: string} = {
                'X-Sumo-Client': 'sumo-javascript-sdk',
                'Content-Type': 'application/json',
            };

            if (this._config.sourceName) { headers['X-Sumo-Name'] = this._config.sourceName; }
            if (this._config.sourceCategory) { headers['X-Sumo-Category'] = this._config.sourceCategory; }
            if (this._config.hostName) { headers['X-Sumo-Host'] = this._config.hostName; }

            if (!this._logsToSend) {
                this._logsToSend = this._pendingLogs;
                this._pendingLogs = [];
            }

            const response = await makeRequest({url: this._endpoint, headers, body: this._logsToSend.join(STR_NEWLINE)});
            this._logsToSend = undefined;
            return response;
        }
        finally {
            this._logSending = false;
        }
    }

    public log(message: string|string[], options?: PerMessageOptions): boolean|Promise<Response|false>;
    public log<T extends object>(message: T|T[], options?: PerMessageOptions): boolean|Promise<Response|false>;
    public log<T extends object>(message: T|T[]|string|string[], optionalConfig?: PerMessageOptions): boolean|Promise<Response|false> {
        if (!message) {
            console.error('SumoLogger.log() requires a message to be provided');
            return false;
        }

        const testEl = Array.isArray(message) ? message[0] : message;

        if (!isDefinedNotNull(testEl)) {
            console.error('SumoLogger.log() requires a value as a message');
            return false;
        }

        if (isObject(testEl) && isEmpty(message)) {
            console.error('SumoLogger.log() requires a non-empty JSON object');
            return false;
        }

        if (!Array.isArray(message)) {
            message = [message] as T[]|string[];
        }

        const client = { url: optionalConfig?.url || this._config.clientUrl };
        const sessionId = optionalConfig?.sessionKey || this._config.sessionKey;
        const timestamp = (optionalConfig?.timestamp ?? new Date()).toJSON();

        for (const msg of message) {
            this._pendingLogs.push(isString(msg) ? JSON.stringify({msg, sessionId, timestamp, ...client }) : JSON.stringify({ sessionId, timestamp, ...client, ...msg}));
        }

        return true;
    }
}

/*************************************************************/
//#region Utility Functions and Constants
/*************************************************************/

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

function isDefinedNotNull<T>(value: T|undefined): value is Exclude<T, null|undefined> { return (typeof value !== TYPE_UNDEFINED) && value !== null; }
function isObject<T extends object = object>(value: any): value is T { return typeof value === TYPE_OBJECT; }
function isString(value: any): value is string { return typeof value === TYPE_STRING; }

function isEmpty<T extends object = never>(value: string|Array<any>|T): boolean {
    if (isString(value) || Array.isArray(value)) { return value.length === 0; }
    return Object.keys(value).length === 0;
}

const TYPE_STRING = 'string';
const TYPE_UNDEFINED = 'undefined';
const TYPE_OBJECT = 'object';

const STR_EMPTY = '';
const STR_NEWLINE = '\n';

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
}

type SumoLoggerConfig = Omit<Required<SumoLoggerOptions>, 'endpoint'>;

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

interface Response {
    data: any;
    status: number;
    statusText: string;
    headers: {[header: string]: string | string[] | undefined},
}

interface RequestConfig {
    url: string;
    headers: {[header: string]: string};
    body: string;
}

//#endregion

module.exports = SumoLogger;

/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { DebugProtocol } from 'vscode-debugprotocol';
import { debug, NotebookDocument, NotebookCell, DebugSession, DebugAdapterTracker, Uri } from 'vscode';
import * as path from 'path';
import { JavaScriptKernel } from '../jsKernel';
import { getCellFromTemporaryPath, getCodeObject, getMappedLocation, getSourceMapsInfo } from '../compiler';

const activeDebuggers = new WeakMap<NotebookDocument, Debugger>();

export class Debugger implements DebugAdapterTracker {
    constructor(
        public readonly document: NotebookDocument,
        public readonly debugSession: DebugSession,
        public readonly kernel: JavaScriptKernel,
        public readonly cell?: NotebookCell
    ) {
        activeDebuggers.set(document, this);
    }
    public stop() {
        void debug.stopDebugging(this.debugSession);
    }
    public onError?(error: Error): void {
        console.error(error);
    }
    public onWillReceiveMessage(message: DebugProtocol.ProtocolMessage) {
        // VS Code -> Debug Adapter
        visitSources(
            message,
            (source) => {
                if (source.path) {
                    const cellPath = this.dumpCell(source.path);
                    if (cellPath) {
                        source.path = cellPath;
                    }
                }
            },
            (request: { source?: DebugProtocol.Source }, location?: { line?: number; column?: number }[]) => {
                if (!request.source?.path || !location) {
                    return;
                }
                const cell = getCellFromTemporaryPath(request.source.path);
                if (!cell) {
                    return;
                }
                const codeObject = getCodeObject(cell);
                if (!codeObject) {
                    return;
                }
                const sourceMap = getSourceMapsInfo(codeObject);
                if (!sourceMap) {
                    return;
                }
                // const cache = (sourceMap.mappingCache = sourceMap.mappingCache || new Map<string, [number, number]>());
                location.forEach((location) => {
                    const mappedLocation = getMappedLocation(codeObject, location, 'VSCodeToDAP');
                    location.line = mappedLocation.line;
                    location.column = mappedLocation.column;
                });
            },
            'VSCodeToDAP'
        );
        console.log(message);
    }

    public onDidSendMessage(message: DebugProtocol.ProtocolMessage) {
        // Debug Adapter -> VS Code
        visitSources(
            message,
            (source) => {
                if (source.path) {
                    const cell = getCellFromTemporaryPath(source.path);
                    if (cell && !cell.document.isClosed) {
                        source.name = path.basename(cell.document.uri.path);
                        if (cell.index >= 0) {
                            source.name += `, Cell ${cell.index + 1}`;
                        }
                        source.path = cell.document.uri.toString();
                    }
                }
            },
            (request: { source?: DebugProtocol.Source }, location?: { line?: number; column?: number }[]) => {
                if (!request.source?.path || !location) {
                    return;
                }
                const cell = getCellFromTemporaryPath(request.source.path);
                if (!cell) {
                    return;
                }
                const codeObject = getCodeObject(cell);
                if (!codeObject) {
                    return;
                }
                const sourceMap = getSourceMapsInfo(codeObject);
                if (!sourceMap) {
                    return;
                }
                // const cache = (sourceMap.mappingCache = sourceMap.mappingCache || new Map<string, [number, number]>());
                location.forEach((location) => {
                    const mappedLocation = getMappedLocation(codeObject, location, 'DAPToVSCode');
                    location.line = mappedLocation.line;
                    location.column = mappedLocation.column;
                });
            },
            'DAPToVSCode'
        );
        console.log(message);
    }
    /**
     * Store cell in temporary file and return its path or undefined if uri does not denote a cell.
     */
    private dumpCell(uri: string): string | undefined {
        try {
            const cellUri = Uri.parse(uri, true);
            if (cellUri.scheme === 'vscode-notebook-cell') {
                // find cell in document by matching its URI
                const cell = this.document.getCells().find((c) => c.document.uri.toString() === uri);
                if (cell) {
                    return getCodeObject(cell).sourceFilename;
                }
            }
        } catch (e) {
            // Oops
        }
        return undefined;
    }
}

// this vistor could be moved into the DAP npm module (it must be kept in sync with the DAP spec)
function visitSources(
    msg: DebugProtocol.ProtocolMessage,
    visitor: (source: DebugProtocol.Source) => void,
    remapLocation: (
        request: { source?: DebugProtocol.Source },
        location?: { line?: number; column?: number }[]
    ) => void,
    _direction: 'DAPToVSCode' | 'VSCodeToDAP'
): void {
    const sourceHook = (source: DebugProtocol.Source | undefined) => {
        if (source) {
            visitor(source);
        }
    };

    switch (msg.type) {
        case 'event': {
            const event = <DebugProtocol.Event>msg;
            switch (event.event) {
                case 'output':
                    sourceHook((<DebugProtocol.OutputEvent>event).body.source);
                    break;
                case 'loadedSource':
                    sourceHook((<DebugProtocol.LoadedSourceEvent>event).body.source);
                    break;
                case 'breakpoint':
                    sourceHook((<DebugProtocol.BreakpointEvent>event).body.breakpoint.source);
                    break;
                default:
                    break;
            }
            break;
        }
        case 'request': {
            const request = <DebugProtocol.Request>msg;
            switch (request.command) {
                case 'setBreakpoints': {
                    const args = <DebugProtocol.SetBreakpointsArguments>request.arguments;
                    sourceHook(args.source);
                    remapLocation(args, args.breakpoints);
                    break;
                }
                case 'breakpointLocations':
                    sourceHook((<DebugProtocol.BreakpointLocationsArguments>request.arguments).source);
                    // sourceHook((<DebugProtocol.BreakpointLocationsArguments>request.arguments));
                    break;
                case 'source':
                    sourceHook((<DebugProtocol.SourceArguments>request.arguments).source);
                    break;
                case 'gotoTargets':
                    sourceHook((<DebugProtocol.GotoTargetsArguments>request.arguments).source);
                    break;
                case 'launchVSCode':
                    //request.arguments.args.forEach(arg => fixSourcePath(arg));
                    break;
                default:
                    break;
            }
            break;
        }
        case 'response': {
            const response = <DebugProtocol.Response>msg;
            if (response.success && response.body) {
                switch (response.command) {
                    case 'stackTrace':
                        (<DebugProtocol.StackTraceResponse>response).body.stackFrames.forEach((frame) => {
                            sourceHook(frame.source);
                            remapLocation(frame, [frame]);
                        });
                        break;
                    case 'loadedSources':
                        (<DebugProtocol.LoadedSourcesResponse>response).body.sources.forEach((source) =>
                            sourceHook(source)
                        );
                        break;
                    case 'scopes':
                        (<DebugProtocol.ScopesResponse>response).body.scopes.forEach((scope) => {
                            sourceHook(scope.source);
                            remapLocation(scope, [scope]);
                        });
                        break;
                    case 'setFunctionBreakpoints':
                        (<DebugProtocol.SetFunctionBreakpointsResponse>response).body.breakpoints.forEach((bp) => {
                            sourceHook(bp.source);
                            remapLocation(bp, [bp]);
                        });
                        break;
                    case 'setBreakpoints':
                        (<DebugProtocol.SetBreakpointsResponse>response).body.breakpoints.forEach((bp) => {
                            sourceHook(bp.source);
                            remapLocation(bp, [bp]);
                        });
                        break;
                    default:
                        break;
                }
            }
            break;
        }
    }
}

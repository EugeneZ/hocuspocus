import WebSocket from 'ws'
import { createServer, IncomingMessage, Server as HTTPServer } from 'http'
import { Doc, encodeStateAsUpdate, applyUpdate } from 'yjs'
import { URLSearchParams } from 'url'
import { Configuration, Extension } from './types'
import Document from './Document'
import Connection from './Connection'

/**
 * Hocuspocus yjs websocket server
 */
export class Hocuspocus {

  configuration: Configuration = {
    extensions: [],
    onChange: () => new Promise(r => r()),
    onConnect: () => new Promise(r => r()),
    onCreateDocument: () => new Promise(r => r()),
    onDestroy: () => new Promise(r => r()),
    onDisconnect: () => new Promise(r => r()),
    onListen: () => new Promise(r => r()),
    onRequest: () => new Promise(r => r()),
    onUpgrade: () => new Promise(r => r()),
    port: 80,
    timeout: 30000,
  }

  documents = new Map()

  httpServer?: HTTPServer

  websocketServer?: WebSocket.Server

  /**
   * Configure the server
   */
  configure(configuration: Partial<Configuration>): Hocuspocus {

    this.configuration = {
      ...this.configuration,
      ...configuration,
    }

    this.configuration.extensions.push({
      onChange: this.configuration.onChange,
      onConnect: this.configuration.onConnect,
      onCreateDocument: this.configuration.onCreateDocument,
      onDestroy: this.configuration.onDestroy,
      onDisconnect: this.configuration.onDisconnect,
      onListen: this.configuration.onListen,
      onRequest: this.configuration.onRequest,
      onUpgrade: this.configuration.onUpgrade,
    })

    return this

  }

  /**
   * Start the server
   */
  async listen(): Promise<void> {

    const websocketServer = new WebSocket.Server({ noServer: true })
    websocketServer.on('connection', this.handleConnection.bind(this))

    const server = createServer((request, response) => {
      this.hooks('onRequest', { request, response })
        .then(() => {
          // default response if all prior hooks don't interfere
          response.writeHead(200, { 'Content-Type': 'text/plain' })
          response.end('OK')
        })
        .catch(e => {
          // if a hook rejects and the error is empty, do nothing
          // this is only meant to prevent later hooks and the
          // default handler to do something. if a error is present
          // just rethrow it
          if (e) throw e
        })
    })

    server.on('upgrade', (request, socket, head) => {
      this.hooks('onUpgrade', { request, socket, head })
        .then(() => {
          // let the default websocket server handle the connection if
          // prior hooks don't interfere
          websocketServer.handleUpgrade(request, socket, head, ws => {
            websocketServer.emit('connection', ws, request)
          })
        })
        .catch(e => {
          // if a hook rejects and the error is empty, do nothing
          // this is only meant to prevent later hooks and the
          // default handler to do something. if a error is present
          // just rethrow it
          if (e) throw e
        })
    })

    this.httpServer = server
    this.websocketServer = websocketServer

    await new Promise((resolve: Function, reject: Function) => {
      server.listen(this.configuration.port, () => {
        this.hooks('onListen', { port: this.configuration.port })
          .then(() => resolve())
          .catch(e => reject(e))
      })
    })
  }

  /**
   * Destroy the server
   */
  async destroy(): Promise<any> {
    this.httpServer?.close()
    this.websocketServer?.close()

    await this.hooks('onDestroy', {})
  }

  /**
   * Handle the incoming websocket connection
   */
  handleConnection(incoming: WebSocket, request: IncomingMessage, context: any = null): void {

    const document = this.createDocument(request)
    const connection = this.createConnection(incoming, request, document, context)

    const hookPayload = {
      clientsCount: document.connectionsCount(),
      context,
      document,
      documentName: document.name,
      requestHeaders: request.headers,
      requestParameters: Hocuspocus.getParameters(request),
    }

    this.hooks('onConnect', hookPayload).catch(e => {
      if (e) throw e
      connection.close()
    })

  }

  /**
   * Handle update of the given document
   * @private
   */
  private handleDocumentUpdate(document: Document, update: Uint8Array, request: IncomingMessage): void {

    this.configuration.extensions.forEach(extension => extension.onChange({
      clientsCount: document.connectionsCount(),
      document,
      documentName: document.name,
      requestHeaders: request.headers,
      requestParameters: Hocuspocus.getParameters(request),
      update,
    }))

  }

  /**
   * Create a new document by the given request
   */
  private createDocument(request: IncomingMessage): Document {

    const documentName = request.url?.slice(1)?.split('?')[0] || ''

    if (this.documents.has(documentName)) {
      return this.documents.get(documentName)
    }

    const document = new Document(documentName)

    document.onUpdate((document, update) => {
      this.handleDocumentUpdate(document, update, request)
    })

    this.hooks(
      'onCreateDocument',
      { document, documentName },
      (loadedDocument: Doc | undefined) => {
        if (loadedDocument instanceof Doc) {
          applyUpdate(document, encodeStateAsUpdate(loadedDocument))
        }
      },
    ).catch(e => {
      throw e
    })

    this.documents.set(documentName, document)

    return document
  }

  /**
   * Create a new connection by the given request and document
   * @private
   */
  private createConnection(connection: WebSocket, request: IncomingMessage, document: Document, context = null): Connection {

    return new Connection(connection, request, document, this.configuration.timeout, context)
      .onClose(document => {

        this.configuration.extensions.forEach(extension => extension.onDisconnect({
          clientsCount: document.connectionsCount(),
          context,
          document,
          documentName: document.name,
          requestHeaders: request.headers,
          requestParameters: Hocuspocus.getParameters(request),
        }))

        if (document.connectionsCount() > 0) {
          return
        }

        this.documents.delete(document.name)
      })

  }

  /**
   * Run the given hook on all configured extensions
   */
  private async hooks(
    name: string,
    hookPayload: any,
    callback: Function | null = null,
  ): Promise<any> {
    const { extensions } = this.configuration

    for (let i = 0; i < extensions.length; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await this.hook(name, extensions[i], hookPayload, callback)
    }
  }

  /**
   * Run the given hook on the given extension.
   */
  private hook(
    name: string,
    extension: Extension,
    hookPayload: any,
    callback: Function | null = null,
  ): Promise<any> {
    // @ts-ignore
    const promise = extension[name] ? extension[name](hookPayload) : new Promise(r => r())
    if (callback) promise.then((...args: any[]) => callback(...args))

    return promise
  }

  /**
   * Get parameters by the given request
   * @private
   */
  private static getParameters(request: IncomingMessage): URLSearchParams {
    const query = request?.url?.split('?') || []
    return new URLSearchParams(query[1] ? query[1] : '')
  }
}

export const Server = new Hocuspocus()

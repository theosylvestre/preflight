package io.github.theosylvestre.preflight

import org.cef.callback.CefCallback
import org.cef.handler.CefResourceHandlerAdapter
import org.cef.misc.IntRef
import org.cef.misc.StringRef
import org.cef.network.CefRequest
import org.cef.network.CefResponse

/** Answers a browser request with [bytes] (404 when null). */
internal class BytesResourceHandler(private val bytes: ByteArray?, private val mimeType: String) : CefResourceHandlerAdapter() {
    private var offset = 0

    override fun processRequest(request: CefRequest, callback: CefCallback): Boolean {
        callback.Continue()
        return true
    }

    override fun getResponseHeaders(response: CefResponse, responseLength: IntRef, redirectUrl: StringRef?) {
        if (bytes == null) {
            response.status = 404
            responseLength.set(0)
            return
        }
        response.status = 200
        response.mimeType = mimeType
        response.setHeaderByName("Cache-Control", "no-store", true)
        responseLength.set(bytes.size)
    }

    override fun readResponse(dataOut: ByteArray, bytesToRead: Int, bytesRead: IntRef, callback: CefCallback): Boolean {
        val data = bytes ?: return false
        if (offset >= data.size) {
            bytesRead.set(0)
            return false
        }
        val n = minOf(bytesToRead, data.size - offset)
        System.arraycopy(data, offset, dataOut, 0, n)
        offset += n
        bytesRead.set(n)
        return true
    }
}

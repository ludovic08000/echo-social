"""Test-only adapter to the real native C ABI; private state stays in pipe I/O."""
import base64
import ctypes as c
import json
import sys

lib = c.CDLL(sys.argv[1])
class Buffer(c.Structure):
    _fields_ = [('data', c.POINTER(c.c_uint8)), ('len', c.c_size_t)]
lib.aegis_crypto_buffer_free.argtypes = [Buffer]
lib.aegis_crypto_last_error_message.restype = c.c_char_p
request = json.load(sys.stdin)
op = request['op']
raw = [base64.b64decode(value) for value in request.get('bytes', [])]
args = []
outputs = []
def blob(value):
    args.extend([c.c_char_p(value), c.c_size_t(len(value))])
def number(value):
    args.append(c.c_uint32(value))
def output():
    buf = Buffer(); outputs.append(buf); args.append(c.byref(buf))
if op == 'store_create':
    number(42); output()
else:
    blob(raw[0])
    if op == 'bundle_create':
        for value in [1, 11, 12, 13]: number(value)
        output(); output()
    else:
        blob(request['local'].encode()); number(1)
        blob(request['remote'].encode()); number(1)
        if op == 'message_decrypt': args.append(c.c_uint8(request['type']))
        blob(raw[1]); output()
        if op == 'message_encrypt':
            message_type = c.c_uint8(); args.append(c.byref(message_type)); output()
        elif op == 'message_decrypt': output()
fn = getattr(lib, 'aegis_crypto_' + op)
fn.restype = c.c_int32
code = fn(*args)
if code != 0:
    raise RuntimeError(lib.aegis_crypto_last_error_message().decode())
try:
    values = [base64.b64encode(c.string_at(buf.data, buf.len)).decode() for buf in outputs]
    if op == 'message_encrypt': values.insert(1, base64.b64encode(bytes([message_type.value])).decode())
    print(json.dumps(values))
finally:
    for buf in outputs: lib.aegis_crypto_buffer_free(buf)

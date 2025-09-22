source .env
if [ -n "$1" ]; then
  TX_HASH="$1"
fi
curl "$RPC_URL" \
  -H 'accept: */*' \
  -H 'content-type: application/json' \
  --data-raw '{"id":1,"jsonrpc":"2.0","method":"debug_traceTransaction","params":["'$TX_HASH'",{"tracer":"callTracer"}]}'




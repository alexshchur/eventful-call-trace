
source .env

if [ -n "$1" ]; then
  TX_HASH="$1"
fi

curl "$RPC_URL" \
  -H 'accept: */*' \
  -H 'content-type: application/json' \
  --data-raw '{
  "jsonrpc": "2.0",
  "method": "debug_traceTransaction",
  "id": 1,
  "params": [
    "'$TX_HASH'",
    {
        "disableStack": true,
        "disableMemory": true,
        "disableStorage": true,
        "enableReturnData": false,
        "timeout": "60s",
        "reexec": 100000000
      }
  ]
}'
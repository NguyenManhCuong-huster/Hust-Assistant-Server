|Trường hợp|Lệnh|
|----------|----|
|Sửa code .js trong server/src/|docker compose up --build -d server|
|Sửa code .env|docker compose up -d server|
|Sửa server/.env|docker compose restart server (env_file đọc lúc start, không cần rebuild)|
|Sửa init_schema.sql (cần re-init DB)|docker compose down -v && docker compose up --build -d  ⚠️ xoá hết data|
|Stop tất cả|docker compose down|
|Stop + xoá data|docker compose down -v|
|Xem log realtime|docker compose logs -f server|
|Vào shell container|docker compose exec server sh|
|Vào psql|docker compose exec postgres_db psql -U admin -d notification_aggregator|


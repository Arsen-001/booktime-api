-- Теневая база для `prisma migrate dev` и права пользователя приложения на неё
CREATE DATABASE IF NOT EXISTS booktime_shadow CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
GRANT ALL PRIVILEGES ON booktime_shadow.* TO 'booktime'@'%';
FLUSH PRIVILEGES;

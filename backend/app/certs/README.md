# Сертификат для ЕИС

`russian_trusted_root_ca.pem` — публичный корневой сертификат Russian Trusted
Root CA, не секрет и не клиентский ключ. Получен 14.11.2026 с официального
хранилища Госуслуг по HTTPS с проверкой TLS:

https://gu-st.ru/content/lending/russian_trusted_root_ca_pem.crt

Инструкция издателя: https://www.gosuslugi.ru/crt

SHA-256 DER:
`D26D2D0231B7C39F92CC738512BA54103519E4405D68B5BD703E9788CA8ECF31`.
Срок: 01.03.2022–27.02.2032 UTC. Издатель и субъект — The Ministry of Digital
Development and Communications / Russian Trusted Root CA.

`sources.http.source_client` добавляет корень к стандартным CA только для
`https://zakupki.gov.ru`. Проверка имени хоста и цепочки остаётся включённой.
OpenRouter и прочие сайты используют стандартное хранилище. Системное доверие
компьютера не изменяется. В P1 при добавлении Chromium этот сертификат нужно
импортировать в отдельный профиль браузера ЕИС, не применять ignore_https_errors.

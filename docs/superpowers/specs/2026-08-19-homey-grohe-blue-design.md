# Homey GROHE Blue Home — Design

## Cel

Stworzyć developerską aplikację Homey SDK v3 dla GROHE Blue Home. Aplikacja łączy się bezpośrednio z chmurą GROHE, wykrywa urządzenia konta, pokazuje monitoring oraz steruje automatycznym płukaniem. Nie zależy od Home Assistant ani zewnętrznego serwera.

## Zakres MVP

- Logowanie kontem używanym w GROHE Watersystems.
- Wykrywanie wszystkich urządzeń typu Blue Home (`type: 104`) i dodawanie każdego jako osobnego urządzenia Homey.
- Monitoring: połączenie, poziom i pozostałe litry filtra, poziom i pozostałe litry CO₂, czas ostatniego pomiaru, czas od ostatniego pobrania, cykle wody gazowanej i niegazowanej.
- Alarmy niskiego poziomu filtra i CO₂.
- Odczyt oraz zapis `config.auto_flush_active`.
- Karty Flow do włączania i wyłączania automatycznego płukania oraz triggery zmian stanu, dostępności i niskich poziomów.

Poza MVP pozostają nalewanie wody, resety filtra/CO₂, ulubione, przypomnienie bezczynności po 24 godzinach i publikacja w Homey App Store.

## Architektura

Projekt używa Homey Compose i SDK v3 na Node.js 22. `GroheClient` odpowiada wyłącznie za OIDC, tokeny i HTTP. `GroheMapper` mapuje odpowiedzi API na stabilny model domenowy. `App` utrzymuje klienta przypisanego do instalacji aplikacji, a driver obsługuje parowanie i listę urządzeń. Każdy `Device` wykonuje polling i publikuje model do capabilities.

Przepływ danych:

1. Pairing przyjmuje e-mail i hasło.
2. Klient wykonuje formularzowy przepływ OIDC i otrzymuje access/refresh token.
3. `/dashboard` dostarcza lokalizacje, pokoje i urządzenia.
4. Driver zwraca urządzenia Blue Home z niezmiennym `appliance_id` jako `data.id`.
5. Device odświeża `/dashboard` co 5 minut i mapuje stan.
6. Zmiana płukania wykonuje `PUT` zasobu appliance z `{ "config": { "auto_flush_active": boolean } }`, po czym polling potwierdza stan.

## Uwierzytelnienie i sekrety

Logowanie odtwarza działający przepływ używany przez pakiet `grohe`: GET formularza OIDC, POST danych logowania, zamiana redirectu `ondus://` na HTTPS i pobranie tokenów. Access token jest odświeżany przed wygaśnięciem przez `/oidc/refresh`.

Hasło istnieje wyłącznie w pamięci podczas parowania i nigdy nie jest utrwalane. Po udanym logowaniu aplikacja przechowuje w prywatnym store Homey tylko refresh token oraz identyfikator konta, nigdy w device settings, logach, błędach ani repozytorium. Logowanie HTTP maskuje nagłówki Authorization, cookies, tokeny, e-mail, hasło, serial i `presharedkey`.

## Model urządzenia Homey

Standardowe capabilities są używane tam, gdzie semantyka pasuje; pozostałe są capabilities niestandardowymi:

- `onoff.auto_flush` — automatyczne płukanie,
- `alarm_generic.connection` — brak łączności,
- `measure_percentage.filter`, `measure_percentage.co2`,
- `measure_water.filter_remaining`, `measure_water.co2_remaining`,
- tekstowe/numeryczne dane diagnostyczne dla ostatniego pomiaru, bezczynności i cykli,
- `alarm_generic.filter_low`, `alarm_generic.co2_low`.

Nazwy końcowe capabilities zostaną zweryfikowane przez Homey CLI; własne identyfikatory będą namespacowane, jeśli SDK nie pozwala na warianty standardowych capabilities.

## Flow

Akcje urządzenia:

- Włącz automatyczne płukanie.
- Wyłącz automatyczne płukanie.

Triggery urządzenia:

- Automatyczne płukanie zostało włączone/wyłączone.
- Urządzenie przeszło online/offline.
- Filtr spadł poniżej progu.
- CO₂ spadło poniżej progu.

Warunek:

- Automatyczne płukanie jest włączone.

Komenda Flow kończy się sukcesem dopiero po potwierdzeniu żądanego stanu przez API. Nie jest automatycznie ponawiana po niejednoznacznym błędzie zapisu.

## Polling i błędy

Domyślny polling wynosi 5 minut. Po komendzie wykonywane jest do pięciu odczytów potwierdzających co 2 sekundy. Maksymalnie jedno odświeżenie lub zapis może działać równocześnie dla urządzenia.

Po trzech kolejnych błędach odczytu urządzenie otrzymuje status unavailable, ale zachowuje ostatnie poprawne pomiary. Udany odczyt zeruje licznik błędów. HTTP 401 wywołuje pojedyncze odświeżenie tokenu i ponowienie bezpiecznego odczytu. Nieudane odświeżenie tokenu oznacza wymagane ponowne logowanie.

## Testy

- Jednostkowe testy OIDC, refresh tokenu, dashboardu i zapisu konfiguracji na mockowanym HTTP.
- Testy mapowania kompletnych, częściowych i błędnych odpowiedzi Blue Home.
- Testy redakcji sekretów.
- Testy pairing/list devices oraz immutable device ID.
- Testy capabilities, progów i kart Flow.
- Walidacja `homey app validate`.
- Instalacja developerska na wskazanym Homey Pro.
- Test rzeczywisty: porównanie odczytów z Watersystems oraz włączenie i wyłączenie automatycznego płukania z Homey, z potwierdzeniem API.

## Kryteria ukończenia

MVP jest ukończone, gdy aplikacja przechodzi testy i walidację, instaluje się na Homey Pro, paruje konto użytkownika, dodaje Blue Home, wyświetla uzgodnione dane oraz dwukierunkowo steruje automatycznym płukaniem przez urządzenie i Flow.

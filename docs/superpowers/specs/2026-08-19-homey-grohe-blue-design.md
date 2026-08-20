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
6. Zmiana płukania wykonuje jeden `PUT` zasobu appliance. Włączenie wysyła `{ "config": { "auto_flush_active": true, "flush_confirmed": true } }`; wyłączenie wysyła wyłącznie `{ "config": { "auto_flush_active": false } }`, aby nie cofać istniejącego potwierdzenia. Odczyty po zapisie potwierdzają stan efektywny.

## Uwierzytelnienie i sekrety

Logowanie odtwarza działający przepływ używany przez pakiet `grohe`: GET formularza OIDC, POST danych logowania, zamiana redirectu `ondus://` na HTTPS i pobranie tokenów. Access token jest odświeżany przed wygaśnięciem przez `/oidc/refresh`.

Hasło istnieje wyłącznie w pamięci podczas parowania i nigdy nie jest utrwalane. Po udanym logowaniu aplikacja przechowuje w prywatnym store Homey tylko refresh token oraz identyfikator konta, nigdy w device settings, logach, błędach ani repozytorium. Logowanie HTTP maskuje nagłówki Authorization, cookies, tokeny, e-mail, hasło, serial i `presharedkey`.

## Model urządzenia Homey

Wdrożone capabilities niestandardowe:

- `grohe_auto_flush` — efektywny stan automatycznego płukania,
- `grohe_online` — stan połączenia,
- `grohe_filter_percent`, `grohe_co2_percent`,
- `grohe_filter_liters`, `grohe_co2_liters`,
- `grohe_measurement_timestamp`, `grohe_idle_minutes`,
- `grohe_still_cycles`, `grohe_carbonated_cycles`,
- `alarm_grohe_filter_low`, `alarm_grohe_co2_low`.

Stan płukania jest efektywnie włączony, gdy `auto_flush_active` jest `true` oraz — tylko jeśli API jawnie zwraca `flush_confirmation_required: true` — `flush_confirmed` także jest `true`.

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

Każda komenda wykonuje dokładnie jeden PUT. Interfejs Watersystems może pokazywać zbuforowany stan płukania aż do wylogowania i ponownego logowania; źródłem potwierdzenia dla Homey są kolejne odczyty backendu.

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

Weryfikacja na Homey Pro potwierdziła instalację, pairing, wykrycie urządzenia typu 104, monitoring oraz backendowe włączenie i wyłączenie. Rzeczywiste przekroczenia progów, kontrolowana awaria i ponowne logowanie po wygaśnięciu sesji pozostają niewykonane; są pokryte testami mockowanymi.

## Kryteria ukończenia

MVP spełnia kryteria instalacji, pairingu, monitoringu i dwukierunkowego sterowania backendem. Ograniczenie cache interfejsu Watersystems jest udokumentowane; pozostałe niewykonane scenariusze live są jawnie oznaczone w rekordzie weryfikacji.

export type InactivityReminderTemplateSeed = {
  key: string;
  category: "SOFT" | "MOTIVATING" | "BUSINESS" | "LIGHT_HUMOR" | "HOOKING" | "CALL_TO_ACTION";
  title: string;
  text: string;
  defaultCtaLabel: "Перейти" | "Далее" | "Открыть раздел" | "В главное меню";
  sortOrder: number;
  languageCode: string;
  isActive: boolean;
};

export const INACTIVITY_REMINDER_TEMPLATES_RU: InactivityReminderTemplateSeed[] = [
  // Категория: МЯГКИЕ (1-5)
  {
    key: "soft_1",
    category: "SOFT",
    title: "Мягкое 1",
    text: "Похоже, вы немного отвлеклись 🙂\nПродолжайте знакомство — впереди самое интересное.\nНажмите кнопку ниже и двигайтесь дальше.",
    defaultCtaLabel: "Далее",
    sortOrder: 1,
    languageCode: "ru",
    isActive: true
  },
  {
    key: "soft_2",
    category: "SOFT",
    title: "Мягкое 2",
    text: "Небольшое напоминание 👋\nСледующий шаг уже ждёт вас.\nОткройте следующий раздел, чтобы не потерять нить.",
    defaultCtaLabel: "Открыть раздел",
    sortOrder: 2,
    languageCode: "ru",
    isActive: true
  },
  {
    key: "soft_3",
    category: "SOFT",
    title: "Мягкое 3",
    text: "Вы остановились совсем рядом с важным моментом ✨\nПотратьте ещё пару минут — и картина станет намного яснее.\nНажмите кнопку ниже.",
    defaultCtaLabel: "Перейти",
    sortOrder: 3,
    languageCode: "ru",
    isActive: true
  },
  {
    key: "soft_4",
    category: "SOFT",
    title: "Мягкое 4",
    text: "Мы сохранили для вас следующий шаг 📌\nВернитесь и продолжайте с того места, где остановились.\nВсё уже готово.",
    defaultCtaLabel: "Далее",
    sortOrder: 4,
    languageCode: "ru",
    isActive: true
  },
  {
    key: "soft_5",
    category: "SOFT",
    title: "Мягкое 5",
    text: "Продолжим? 🙂\nСледующий раздел поможет лучше понять, как всё устроено.\nНажмите кнопку и идите дальше.",
    defaultCtaLabel: "Перейти",
    sortOrder: 5,
    languageCode: "ru",
    isActive: true
  },

  // Категория: МОТИВИРУЮЩИЕ (6-10)
  {
    key: "motivating_1",
    category: "MOTIVATING",
    title: "Мотивация 1",
    text: "Вы уже на хорошем пути 🚀\nОстался ещё один шаг, чтобы увидеть картину целиком.\nПереходите дальше.",
    defaultCtaLabel: "Перейти",
    sortOrder: 6,
    languageCode: "ru",
    isActive: true
  },
  {
    key: "motivating_2",
    category: "MOTIVATING",
    title: "Мотивация 2",
    text: "Самое полезное часто начинается со следующего клика ⚡\nОткройте следующий раздел и двигайтесь вперёд.",
    defaultCtaLabel: "Открыть раздел",
    sortOrder: 7,
    languageCode: "ru",
    isActive: true
  },
  {
    key: "motivating_3",
    category: "MOTIVATING",
    title: "Мотивация 3",
    text: "Каждый следующий шаг приближает к результату 🎯\nНе останавливайтесь сейчас — нажмите кнопку ниже.",
    defaultCtaLabel: "Далее",
    sortOrder: 8,
    languageCode: "ru",
    isActive: true
  },
  {
    key: "motivating_4",
    category: "MOTIVATING",
    title: "Мотивация 4",
    text: "Вы уже прошли часть пути 💪\nПродолжайте, чтобы не терять темп и дойти до сути.",
    defaultCtaLabel: "Перейти",
    sortOrder: 9,
    languageCode: "ru",
    isActive: true
  },
  {
    key: "motivating_5",
    category: "MOTIVATING",
    title: "Мотивация 5",
    text: "Немного внимания сейчас — больше понимания потом 🧠\nСледующий материал действительно стоит открыть.",
    defaultCtaLabel: "Далее",
    sortOrder: 10,
    languageCode: "ru",
    isActive: true
  },

  // Категория: ДЕЛОВЫЕ (11-15)
  {
    key: "business_1",
    category: "BUSINESS",
    title: "Деловое 1",
    text: "Напоминаем: следующий этап ещё не открыт 📘\nПродолжите просмотр, чтобы получить полную картину.\nНажмите кнопку ниже.",
    defaultCtaLabel: "Открыть раздел",
    sortOrder: 11,
    languageCode: "ru",
    isActive: true
  },
  {
    key: "business_2",
    category: "BUSINESS",
    title: "Деловое 2",
    text: "Вы остановились на промежуточном этапе.\nСледующий раздел завершает логику этого блока.\nПерейдите далее.",
    defaultCtaLabel: "Далее",
    sortOrder: 12,
    languageCode: "ru",
    isActive: true
  },
  {
    key: "business_3",
    category: "BUSINESS",
    title: "Деловое 3",
    text: "Чтобы не упустить важные детали, рекомендуем открыть следующий материал.\nЭто займёт немного времени, но даст больше ясности.",
    defaultCtaLabel: "Перейти",
    sortOrder: 13,
    languageCode: "ru",
    isActive: true
  },
  {
    key: "business_4",
    category: "BUSINESS",
    title: "Деловое 4",
    text: "Продолжение доступно ниже.\nОткройте следующий раздел, чтобы завершить этот этап.",
    defaultCtaLabel: "Открыть раздел",
    sortOrder: 14,
    languageCode: "ru",
    isActive: true
  },
  {
    key: "business_5",
    category: "BUSINESS",
    title: "Деловое 5",
    text: "Вы ещё не дошли до ключевого блока.\nНажмите кнопку ниже и продолжайте знакомство.",
    defaultCtaLabel: "Далее",
    sortOrder: 15,
    languageCode: "ru",
    isActive: true
  },

  // Категория: С ЛЁГКИМ ЮМОРОМ (16-20)
  {
    key: "humor_1",
    category: "LIGHT_HUMOR",
    title: "Юмор 1",
    text: "Материал не убежал, но скучает без вас 😄\nНажмите кнопку ниже и продолжим.",
    defaultCtaLabel: "Перейти",
    sortOrder: 16,
    languageCode: "ru",
    isActive: true
  },
  {
    key: "humor_2",
    category: "LIGHT_HUMOR",
    title: "Юмор 2",
    text: "Кажется, кто-то нажал паузу ⏸\nПора снова включиться и пройти следующий шаг.",
    defaultCtaLabel: "Далее",
    sortOrder: 17,
    languageCode: "ru",
    isActive: true
  },
  {
    key: "humor_3",
    category: "LIGHT_HUMOR",
    title: "Юмор 3",
    text: "Следующий раздел уже смотрит на вас с надеждой 👀\nНе заставляйте его ждать слишком долго.",
    defaultCtaLabel: "Открыть раздел",
    sortOrder: 18,
    languageCode: "ru",
    isActive: true
  },
  {
    key: "humor_4",
    category: "LIGHT_HUMOR",
    title: "Юмор 4",
    text: "Тут осталось буквально “ещё чуть-чуть” 😌\nНажмите кнопку — и поедем дальше.",
    defaultCtaLabel: "Перейти",
    sortOrder: 19,
    languageCode: "ru",
    isActive: true
  },
  {
    key: "humor_5",
    category: "LIGHT_HUMOR",
    title: "Юмор 5",
    text: "Вы почти у следующей подсказки 🕵️\nОткройте раздел ниже, там как раз самое полезное.",
    defaultCtaLabel: "Далее",
    sortOrder: 20,
    languageCode: "ru",
    isActive: true
  },

  // Категория: ЦЕПЛЯЮЩИЕ (21-24)
  {
    key: "hooking_1",
    category: "HOOKING",
    title: "Цепляющее 1",
    text: "Важный блок прямо впереди 🔥\nНе останавливайтесь за шаг до сути — переходите дальше.",
    defaultCtaLabel: "Перейти",
    sortOrder: 21,
    languageCode: "ru",
    isActive: true
  },
  {
    key: "hooking_2",
    category: "HOOKING",
    title: "Цепляющее 2",
    text: "Следующий экран может многое расставить по местам 💡\nНажмите кнопку ниже и посмотрите продолжение.",
    defaultCtaLabel: "Открыть раздел",
    sortOrder: 22,
    languageCode: "ru",
    isActive: true
  },
  {
    key: "hooking_3",
    category: "HOOKING",
    title: "Цепляющее 3",
    text: "Вы остановились перед сильным фрагментом 🚪\nОткройте его сейчас, чтобы не потерять интерес и логику.",
    defaultCtaLabel: "Перейти",
    sortOrder: 23,
    languageCode: "ru",
    isActive: true
  },
  {
    key: "hooking_4",
    category: "HOOKING",
    title: "Цепляющее 4",
    text: "Продолжение уже подготовлено для вас ✅\nОсталось только нажать кнопку и пройти дальше.",
    defaultCtaLabel: "Далее",
    sortOrder: 24,
    languageCode: "ru",
    isActive: true
  },

  // Дополнительно: 6 шаблонов (25-30)
  {
    key: "soft_6",
    category: "SOFT",
    title: "Мягкое 6",
    text: "Кажется, вы на шаге от продолжения 🙂\nНебольшой клик — и пазл сложится в целое.",
    defaultCtaLabel: "Далее",
    sortOrder: 25,
    languageCode: "ru",
    isActive: true
  },
  {
    key: "soft_7",
    category: "SOFT",
    title: "Мягкое 7",
    text: "Мы ждём ваш следующий шаг 🌿\nОткройте нужный раздел и продолжим без лишней суеты.",
    defaultCtaLabel: "Перейти",
    sortOrder: 26,
    languageCode: "ru",
    isActive: true
  },
  {
    key: "motivating_6",
    category: "MOTIVATING",
    title: "Мотивация 6",
    text: "Вы уже близко 🚶‍♂️\nСделайте ещё один шаг — и станет понятнее, куда двигаться дальше.",
    defaultCtaLabel: "Открыть раздел",
    sortOrder: 27,
    languageCode: "ru",
    isActive: true
  },
  {
    key: "motivating_7",
    category: "MOTIVATING",
    title: "Мотивация 7",
    text: "Продолжение прямо перед вами ⚡\nНажмите кнопку ниже и двигайтесь дальше спокойно.",
    defaultCtaLabel: "Далее",
    sortOrder: 28,
    languageCode: "ru",
    isActive: true
  },
  {
    key: "business_6",
    category: "BUSINESS",
    title: "Деловое 6",
    text: "Следующий блок поможет собрать картину 📋\nОткройте следующий раздел и продолжите по плану.",
    defaultCtaLabel: "Открыть раздел",
    sortOrder: 29,
    languageCode: "ru",
    isActive: true
  },
  {
    key: "hooking_5",
    category: "HOOKING",
    title: "Цепляющее 5",
    text: "Важная часть уже подготовлена ✅\nНажмите кнопку — и перейдите к продолжению.",
    defaultCtaLabel: "Перейти",
    sortOrder: 30,
    languageCode: "ru",
    isActive: true
  },
  {
    key: "action_partner_1",
    category: "CALL_TO_ACTION",
    title: "Действие: Партнер 1",
    text: "Вы уже у точки старта к результату 🚀\nНажмите «Стать партнером / Регистрация» и закрепите за собой место в системе.\nЕсли нужен быстрый разбор по шагам — нажмите «Связь с наставником».",
    defaultCtaLabel: "Перейти",
    sortOrder: 31,
    languageCode: "ru",
    isActive: true
  },
  {
    key: "action_partner_2",
    category: "CALL_TO_ACTION",
    title: "Действие: Партнер 2",
    text: "Самый сильный момент — действовать сейчас ⚡\nОдин клик по «Стать партнером / Регистрация» открывает вам следующий уровень.\nХотите без ошибок с первого раза? Пишите наставнику.",
    defaultCtaLabel: "Далее",
    sortOrder: 32,
    languageCode: "ru",
    isActive: true
  },
  {
    key: "action_partner_3",
    category: "CALL_TO_ACTION",
    title: "Действие: Партнер 3",
    text: "Чтобы не терять темп, переходите к подключению прямо сейчас.\nНажмите «Стать партнером / Регистрация» и завершите ключевой шаг.\nЕсли есть вопросы по стратегии, выберите «Связь с наставником».",
    defaultCtaLabel: "Открыть раздел",
    sortOrder: 33,
    languageCode: "ru",
    isActive: true
  },
  {
    key: "action_partner_4",
    category: "CALL_TO_ACTION",
    title: "Действие: Партнер 4",
    text: "Вы уже рядом с решением, которое меняет доход 💼\nЖмите «Стать партнером / Регистрация», чтобы не откладывать прогресс.\nНужна личная поддержка? «Связь с наставником» — и вас доведут до результата.",
    defaultCtaLabel: "Перейти",
    sortOrder: 34,
    languageCode: "ru",
    isActive: true
  },
  {
    key: "action_partner_5",
    category: "CALL_TO_ACTION",
    title: "Действие: Партнер 5",
    text: "Лучшее время для следующего шага — сейчас 🔥\nНажмите «Стать партнером / Регистрация» и подключайтесь к ARB Core.\nЕсли хотите пройти путь быстрее, нажмите «Связь с наставником».",
    defaultCtaLabel: "Далее",
    sortOrder: 35,
    languageCode: "ru",
    isActive: true
  },
  {
    key: "soft_8",
    category: "SOFT",
    title: "Мягкое 8",
    text: "Вы уже отлично идете по шагам 🌿\nНажмите «Стать партнером / Регистрация» и закрепите прогресс.\nЕсли нужна помощь, выберите «Связь с наставником».",
    defaultCtaLabel: "Далее",
    sortOrder: 36,
    languageCode: "ru",
    isActive: true
  },
  {
    key: "soft_9",
    category: "SOFT",
    title: "Мягкое 9",
    text: "Остался один спокойный шаг к действию 🙂\nНажмите «Стать партнером / Регистрация».\nПри вопросах — «Связь с наставником».",
    defaultCtaLabel: "Перейти",
    sortOrder: 37,
    languageCode: "ru",
    isActive: true
  },
  {
    key: "soft_10",
    category: "SOFT",
    title: "Мягкое 10",
    text: "Чтобы не терять темп, переходите к подключению ✨\nЖмите «Стать партнером / Регистрация».\nНужна уверенность перед стартом? Нажмите «Связь с наставником».",
    defaultCtaLabel: "Открыть раздел",
    sortOrder: 38,
    languageCode: "ru",
    isActive: true
  },
  {
    key: "motivating_8",
    category: "MOTIVATING",
    title: "Мотивация 8",
    text: "Ваш следующий клик может изменить результат дня 🚀\nНажмите «Стать партнером / Регистрация» прямо сейчас.\nЕсли хотите быстрее и точнее — «Связь с наставником».",
    defaultCtaLabel: "Перейти",
    sortOrder: 39,
    languageCode: "ru",
    isActive: true
  },
  {
    key: "motivating_9",
    category: "MOTIVATING",
    title: "Мотивация 9",
    text: "Вы уже достаточно подготовлены, пора в действие ⚡\nЖмите «Стать партнером / Регистрация» и продолжайте путь.\nНужен план под вас? «Связь с наставником».",
    defaultCtaLabel: "Далее",
    sortOrder: 40,
    languageCode: "ru",
    isActive: true
  },
  {
    key: "motivating_10",
    category: "MOTIVATING",
    title: "Мотивация 10",
    text: "Не откладывайте момент старта — он уже здесь 🔥\nНажмите «Стать партнером / Регистрация».\nЕсли хотите пройти без ошибок, нажмите «Связь с наставником».",
    defaultCtaLabel: "Открыть раздел",
    sortOrder: 41,
    languageCode: "ru",
    isActive: true
  },
  {
    key: "business_7",
    category: "BUSINESS",
    title: "Деловое 7",
    text: "Логичный следующий шаг — регистрация в системе.\nНажмите «Стать партнером / Регистрация» для продолжения.\nПо вопросам по структуре — «Связь с наставником».",
    defaultCtaLabel: "Перейти",
    sortOrder: 42,
    languageCode: "ru",
    isActive: true
  },
  {
    key: "business_8",
    category: "BUSINESS",
    title: "Деловое 8",
    text: "Вы у точки принятия решения.\nНажмите «Стать партнером / Регистрация», чтобы зафиксировать следующий этап.\nДля консультации нажмите «Связь с наставником».",
    defaultCtaLabel: "Далее",
    sortOrder: 43,
    languageCode: "ru",
    isActive: true
  },
  {
    key: "business_9",
    category: "BUSINESS",
    title: "Деловое 9",
    text: "Переход к действию займет меньше минуты.\nНажмите «Стать партнером / Регистрация».\nЕсли нужно согласовать шаги, выберите «Связь с наставником».",
    defaultCtaLabel: "Открыть раздел",
    sortOrder: 44,
    languageCode: "ru",
    isActive: true
  },
  {
    key: "business_10",
    category: "BUSINESS",
    title: "Деловое 10",
    text: "Чтобы не терять время, завершите этот этап сейчас.\nНажмите «Стать партнером / Регистрация».\nПри необходимости поддержки используйте «Связь с наставником».",
    defaultCtaLabel: "Перейти",
    sortOrder: 45,
    languageCode: "ru",
    isActive: true
  },
  {
    key: "humor_6",
    category: "LIGHT_HUMOR",
    title: "Юмор 6",
    text: "Кнопка «Стать партнером / Регистрация» уже подмигивает вам 😄\nНажмите ее и поехали дальше.\nЕсли хочется с проводником — «Связь с наставником».",
    defaultCtaLabel: "Далее",
    sortOrder: 46,
    languageCode: "ru",
    isActive: true
  },
  {
    key: "humor_7",
    category: "LIGHT_HUMOR",
    title: "Юмор 7",
    text: "Пауза хороша, но действие лучше ⏸➡️\nЖмите «Стать партнером / Регистрация».\nВопросы? «Связь с наставником» всегда рядом.",
    defaultCtaLabel: "Перейти",
    sortOrder: 47,
    languageCode: "ru",
    isActive: true
  },
  {
    key: "humor_8",
    category: "LIGHT_HUMOR",
    title: "Юмор 8",
    text: "Мы проверили: кнопка регистрации не кусается 😎\nНажмите «Стать партнером / Регистрация».\nЕсли нужно сопровождение, нажмите «Связь с наставником».",
    defaultCtaLabel: "Открыть раздел",
    sortOrder: 48,
    languageCode: "ru",
    isActive: true
  },
  {
    key: "humor_9",
    category: "LIGHT_HUMOR",
    title: "Юмор 9",
    text: "Тут два правильных варианта: зарегистрироваться или написать наставнику 😌\nНачните с «Стать партнером / Регистрация».\nЛибо сразу «Связь с наставником».",
    defaultCtaLabel: "Далее",
    sortOrder: 49,
    languageCode: "ru",
    isActive: true
  },
  {
    key: "humor_10",
    category: "LIGHT_HUMOR",
    title: "Юмор 10",
    text: "Если это знак — то очень понятный 📌\nНажмите «Стать партнером / Регистрация» и продолжайте.\nНужен штурман? «Связь с наставником».",
    defaultCtaLabel: "Перейти",
    sortOrder: 50,
    languageCode: "ru",
    isActive: true
  },
  {
    key: "hooking_6",
    category: "HOOKING",
    title: "Цепляющее 6",
    text: "Вы в одном шаге от точки, где начинается движение 🔥\nНажмите «Стать партнером / Регистрация» сейчас.\nНужен разбор перед стартом? «Связь с наставником».",
    defaultCtaLabel: "Перейти",
    sortOrder: 51,
    languageCode: "ru",
    isActive: true
  },
  {
    key: "hooking_7",
    category: "HOOKING",
    title: "Цепляющее 7",
    text: "Дальше — только действие.\nЖмите «Стать партнером / Регистрация» и фиксируйте свой старт.\nЕсли хотите идти с поддержкой, выберите «Связь с наставником».",
    defaultCtaLabel: "Далее",
    sortOrder: 52,
    languageCode: "ru",
    isActive: true
  },
  {
    key: "hooking_8",
    category: "HOOKING",
    title: "Цепляющее 8",
    text: "Сейчас лучший момент перейти от просмотра к результату ⚡\nНажмите «Стать партнером / Регистрация».\nЕсли нужна уверенность по шагам — «Связь с наставником».",
    defaultCtaLabel: "Открыть раздел",
    sortOrder: 53,
    languageCode: "ru",
    isActive: true
  },
  {
    key: "hooking_9",
    category: "HOOKING",
    title: "Цепляющее 9",
    text: "Вы почти у цели, не останавливайтесь сейчас.\nЖмите «Стать партнером / Регистрация».\nПри любых сомнениях — «Связь с наставником».",
    defaultCtaLabel: "Перейти",
    sortOrder: 54,
    languageCode: "ru",
    isActive: true
  },
  {
    key: "hooking_10",
    category: "HOOKING",
    title: "Цепляющее 10",
    text: "Следующее действие определяет ваш темп на ближайшие недели 🚀\nНажмите «Стать партнером / Регистрация».\nЛибо выберите «Связь с наставником» и начните с опорой.",
    defaultCtaLabel: "Далее",
    sortOrder: 55,
    languageCode: "ru",
    isActive: true
  },
  {
    key: "cta_6",
    category: "CALL_TO_ACTION",
    title: "CTA 6",
    text: "Переходите к главному шагу: «Стать партнером / Регистрация».\nЕсли хотите быстро разобраться по шагам, нажмите «Связь с наставником».",
    defaultCtaLabel: "Перейти",
    sortOrder: 56,
    languageCode: "ru",
    isActive: true
  },
  {
    key: "cta_7",
    category: "CALL_TO_ACTION",
    title: "CTA 7",
    text: "Не откладывайте старт.\nНажмите «Стать партнером / Регистрация» прямо сейчас.\nЕсли нужны ответы до регистрации — «Связь с наставником».",
    defaultCtaLabel: "Далее",
    sortOrder: 57,
    languageCode: "ru",
    isActive: true
  },
  {
    key: "cta_8",
    category: "CALL_TO_ACTION",
    title: "CTA 8",
    text: "Ваш следующий клик — это «Стать партнером / Регистрация».\nДля персональной помощи используйте «Связь с наставником».",
    defaultCtaLabel: "Открыть раздел",
    sortOrder: 58,
    languageCode: "ru",
    isActive: true
  },
  {
    key: "cta_9",
    category: "CALL_TO_ACTION",
    title: "CTA 9",
    text: "Сделайте шаг к подключению сегодня.\nНажмите «Стать партнером / Регистрация».\nЕсли хотите стартовать уверенно — «Связь с наставником».",
    defaultCtaLabel: "Перейти",
    sortOrder: 59,
    languageCode: "ru",
    isActive: true
  },
  {
    key: "cta_10",
    category: "CALL_TO_ACTION",
    title: "CTA 10",
    text: "Готовы к действию? Нажмите «Стать партнером / Регистрация».\nНужен быстрый созвон/разбор — выберите «Связь с наставником».",
    defaultCtaLabel: "Далее",
    sortOrder: 60,
    languageCode: "ru",
    isActive: true
  }
];


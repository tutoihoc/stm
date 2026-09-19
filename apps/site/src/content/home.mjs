import { RELEASES, UPSTREAM } from './strings.mjs';

/**
 * The landing page, said twice.
 *
 * Both languages carry the same shape - same sections, same number of cards,
 * same order - so the page can be rendered from one template and a reader who
 * switches language lands on the same place in the page rather than somewhere
 * else entirely. The build checks that shape before it writes anything.
 */

export const home = {
  en: {
    title: 'Run SillyTavern without the terminal',
    description: 'A control panel that installs, runs, shares, backs up and watches SillyTavern on Windows, Android, macOS, Linux and Docker.',
    hero: {
      heading: 'Run SillyTavern without the terminal',
      lede: `One control panel that installs, runs, shares, backs up and watches [SillyTavern](${UPSTREAM}) — on Windows, Android, macOS, Linux and Docker.`,
      primary: { href: RELEASES, label: 'Download for Windows', icon: 'download' },
      secondary: { href: '/docs', label: 'Read the documentation', icon: 'book' },
      meta: [
        { icon: 'check', label: 'Free and open source, AGPL-3.0' },
        { icon: 'lock', label: 'Your data never leaves your machine' },
        { icon: 'languages', label: 'English and Tiếng Việt' },
      ],
      shot: 'overview',
      shotAlt: 'The manager overview page: SillyTavern running, remote access, data and backups, system usage and live logs',
    },
    what: {
      eyebrow: 'What it does',
      heading: 'SillyTavern, without the parts nobody enjoys',
      lede: 'SillyTavern is a terminal, a Git checkout and a folder of data you must not lose. This turns all three into a page you can open from any device.',
      cards: [
        { icon: 'download', title: 'Install and update', body: 'Pick a release or a branch and press Install. It clones, installs dependencies, health-checks the build and reports Ready only once SillyTavern answers on its port. It tells you when a newer release is out.' },
        { icon: 'terminal', title: 'Run and watch', body: 'Start, stop and open SillyTavern from the panel, with live logs from the manager, SillyTavern, the installer, backups and the tunnel in one searchable feed.' },
        { icon: 'shield', title: 'Share safely', body: 'SillyTavern itself stays on localhost. Other devices and Cloudflare Tunnel reach it through an access gateway that asks for a passcode first and never forwards the admin panel.' },
        { icon: 'globe', title: 'A link that keeps working', body: 'A Quick Tunnel’s address changes every time it starts. Sign in to Cloudflare and the manager puts sillytavern.<you>.workers.dev in front of it, on your own account, and moves it to each new tunnel — so the link you send stays the link that works.' },
        { icon: 'archive', title: 'Back up', body: 'Scheduled and manual ZIP archives, compatible with SillyTavern’s own exports, plus previewed restores and a safety snapshot before anything is replaced.' },
        { icon: 'cloud', title: 'Back up off-site', body: 'One button signs in to Cloudflare, finds or creates an R2 bucket in your own account and keeps recovery points there. No keys to create or paste — or bring your own S3 keys.' },
        { icon: 'chart', title: 'Know your usage', body: 'Requests, tokens, cache hits and latency per day, per provider and per model, measured from SillyTavern’s own traffic. Nothing about it leaves the machine.' },
        { icon: 'layers', title: 'Keep data separate', body: 'Named profiles for separate SillyTavern data sets, switched from the panel, each with its own backups.' },
        { icon: 'languages', title: 'Speak your language', body: 'English and Vietnamese, light and dark, desktop and phone. The panel is usable with one thumb on a bus.' },
      ],
    },
    install: {
      eyebrow: 'Install',
      heading: 'Six ways in, one first run',
      lede: 'Whichever you choose, the first visit asks you to create one administrator password. Then pick a SillyTavern version and press Install.',
      cards: [
        { icon: 'monitor', title: 'Windows', body: 'Download the portable ZIP, extract it, double-click. Node.js is already inside; nothing needs a terminal.', href: '/docs#windows', go: 'Windows guide' },
        { icon: 'phone', title: 'Android · Termux', body: 'Three blocks of commands to paste. The manager then runs on the phone and is opened in the phone’s browser.', href: '/docs#android', go: 'Termux guide' },
        { icon: 'apple', title: 'macOS', body: 'Node.js 22, a clone, npm ci, and the Unix launcher. Apple Silicon and Intel alike.', href: '/docs#macos', go: 'macOS guide' },
        { icon: 'server', title: 'Linux and VPS', body: 'The same launcher, plus a systemd unit if you want it to come back after a reboot.', href: '/docs#linux', go: 'Linux guide' },
        { icon: 'box', title: 'Docker', body: 'Build the image, mount a volume at /data, publish 7860 and 8001. Hosted platforms work the same way.', href: '/docs#docker', go: 'Docker guide' },
        { icon: 'npm', title: 'npm', body: 'npx sillytavern-manager, or install it globally. The published package carries the built panel.', href: '/docs#npm', go: 'npm guide' },
      ],
    },
    how: {
      eyebrow: 'How it works',
      heading: 'Three ports, and two different links',
      lede: 'SillyTavern is never the thing exposed. What you share is the gateway, which asks for a passcode and never forwards the admin panel. The panel has a separate link of its own, behind the manager password, for when the machine you need is not the one in front of you.',
      caption: 'The link you share reaches the gateway. The panel’s own link is a different switch, and it is not for sharing.',
      table: {
        columns: ['Port', 'What listens', 'Who can reach it'],
        rows: [
          ['7860', 'The manager panel', 'This machine, and you from anywhere once you switch its own link on'],
          ['8000', 'SillyTavern', 'This machine only'],
          ['8001', 'The access gateway', 'Your local network or a Cloudflare Tunnel, after a passcode'],
        ],
      },
      note: 'The link you give somebody else opens the gateway, never the panel: nobody who has it can install, restore or delete anything. Opening the panel to the internet is a second switch, in Settings, and it asks for the manager password.',
    },
    screens: {
      eyebrow: 'The panel',
      heading: 'Built to be read at a glance',
      lede: 'The same interface on a desktop and on a phone, in light and dark, in English and Vietnamese.',
      shots: [
        { name: 'data', alt: 'The data page: profiles, local backups and Cloudflare R2 recovery points' },
        { name: 'metrics', alt: 'The usage page: requests, tokens, cache hits and latency per day, provider and model' },
        { name: 'settings', alt: 'The settings page: security, performance, extensions, API keys and chat backups' },
      ],
    },
    backups: {
      eyebrow: 'Backups',
      heading: 'Your data, kept somewhere else as well',
      lede: 'Local archives are always available. Off-site is one button, into a bucket in your own Cloudflare account.',
      points: [
        { icon: 'archive', title: 'Compatible archives', body: 'A streaming ZIP that SillyTavern’s own import understands. Secrets are excluded by default and including them is a deliberate act with a warning.' },
        { icon: 'check', title: 'Previewed restores', body: 'An archive is read and shown before anything is written, and a safety snapshot is taken before a replace or a profile switch.' },
        { icon: 'cloud', title: 'Your Cloudflare, not ours', body: 'Sign in, pick the account, and the bucket is created in it. Backups go from your machine to your bucket; no server of this project is in the path.' },
      ],
      note: 'Backups are a tool, not a guarantee. Test a restore, and keep at least one copy the manager did not make.',
    },
    privacy: {
      eyebrow: 'Privacy',
      heading: 'Nothing you write ever reaches us',
      body: [
        'There is no account, no cloud and no copy of your data held by this project. Chats, characters, prompts, settings, backups and API keys stay on machines you control.',
        'The manager sends one thing: a small, allowlisted usage summary — platform, version, and per request the provider, model, endpoint hostname, token counts, status and duration. It never sends prompts, chats, model responses, API keys, file names, paths, IP addresses or query strings.',
        'The complete list, and how to switch the sending off entirely, is in the [Privacy Notice](/privacy).',
      ],
    },
    cta: {
      heading: 'Start with one download',
      lede: 'Nothing to sign up for. The Windows build is portable; every other platform is a clone and a launcher.',
      primary: { href: RELEASES, label: 'Download the latest release', icon: 'download' },
      secondary: { href: '/docs', label: 'Read the documentation first', icon: 'book' },
    },
  },
  vi: {
    title: 'Chạy SillyTavern mà không cần dòng lệnh',
    description: 'Bảng điều khiển giúp cài đặt, chạy, chia sẻ, sao lưu và theo dõi SillyTavern trên Windows, Android, macOS, Linux và Docker.',
    hero: {
      heading: 'Chạy SillyTavern mà không cần dòng lệnh',
      lede: `Một bảng điều khiển duy nhất để cài đặt, chạy, chia sẻ, sao lưu và theo dõi [SillyTavern](${UPSTREAM}) — trên Windows, Android, macOS, Linux và Docker.`,
      primary: { href: RELEASES, label: 'Tải cho Windows', icon: 'download' },
      secondary: { href: '/docs', label: 'Đọc tài liệu hướng dẫn', icon: 'book' },
      meta: [
        { icon: 'check', label: 'Miễn phí, mã nguồn mở, giấy phép AGPL-3.0' },
        { icon: 'lock', label: 'Dữ liệu không bao giờ rời khỏi máy bạn' },
        { icon: 'languages', label: 'Tiếng Việt và English' },
      ],
      shot: 'overview',
      shotAlt: 'Trang tổng quan của trình quản lý: SillyTavern đang chạy, truy cập từ xa, dữ liệu và sao lưu, tài nguyên hệ thống và nhật ký trực tiếp',
    },
    what: {
      eyebrow: 'Làm được gì',
      heading: 'SillyTavern, bỏ đi những phần chẳng ai thích',
      lede: 'SillyTavern là một cửa sổ dòng lệnh, một bản Git và một thư mục dữ liệu bạn không được phép mất. Cả ba giờ gói lại thành một trang bạn mở được từ bất kỳ thiết bị nào.',
      cards: [
        { icon: 'download', title: 'Cài đặt và cập nhật', body: 'Chọn một bản phát hành hoặc một nhánh rồi bấm Cài đặt. Trình quản lý clone, cài phụ thuộc, kiểm tra sức khoẻ bản dựng và chỉ báo Sẵn sàng khi SillyTavern thực sự trả lời trên cổng của nó. Có bản mới, nó sẽ nói.' },
        { icon: 'terminal', title: 'Chạy và theo dõi', body: 'Bật, tắt và mở SillyTavern ngay trong bảng điều khiển, kèm nhật ký trực tiếp từ trình quản lý, SillyTavern, trình cài đặt, sao lưu và tunnel trong một luồng tìm kiếm được.' },
        { icon: 'shield', title: 'Chia sẻ an toàn', body: 'Bản thân SillyTavern vẫn chỉ nằm ở localhost. Thiết bị khác và Cloudflare Tunnel đi qua một cổng truy cập, cổng này hỏi mã trước và không bao giờ chuyển tiếp trang quản trị.' },
        { icon: 'globe', title: 'Link dùng được lâu dài', body: 'Địa chỉ Quick Tunnel đổi sau mỗi lần khởi động. Đăng nhập Cloudflare là trình quản lý đặt sillytavern.<bạn>.workers.dev đứng trước nó, ngay trên tài khoản của bạn, và tự trỏ sang tunnel mới — link bạn gửi đi vẫn là link chạy được.' },
        { icon: 'archive', title: 'Sao lưu', body: 'Tệp ZIP theo lịch hoặc thủ công, tương thích với bản xuất của chính SillyTavern, kèm xem trước khi phục hồi và một bản chụp an toàn trước khi có gì bị ghi đè.' },
        { icon: 'cloud', title: 'Sao lưu ra ngoài máy', body: 'Một nút đăng nhập Cloudflare, tìm hoặc tạo bucket R2 trong chính tài khoản của bạn và giữ các điểm phục hồi ở đó. Không phải tạo hay dán khoá nào — hoặc bạn tự mang khoá S3 của mình.' },
        { icon: 'chart', title: 'Biết mình dùng bao nhiêu', body: 'Số lượt gọi, token, tỷ lệ trúng bộ nhớ đệm và độ trễ theo ngày, theo nhà cung cấp và theo mô hình, đo từ chính lưu lượng của SillyTavern. Không gì trong đó rời khỏi máy.' },
        { icon: 'layers', title: 'Tách riêng dữ liệu', body: 'Các hồ sơ dữ liệu SillyTavern riêng biệt có tên, chuyển qua lại ngay trong bảng điều khiển, mỗi hồ sơ có bản sao lưu riêng.' },
        { icon: 'languages', title: 'Nói ngôn ngữ của bạn', body: 'Tiếng Việt và tiếng Anh, giao diện sáng và tối, máy tính và điện thoại. Bảng điều khiển dùng được bằng một ngón tay khi đang ngồi trên xe.' },
      ],
    },
    install: {
      eyebrow: 'Cài đặt',
      heading: 'Chọn cách cài hợp với máy của bạn',
      lede: 'Dù chọn cách nào, lần mở đầu tiên cũng chỉ yêu cầu bạn tạo một mật khẩu quản trị. Sau đó chọn phiên bản SillyTavern rồi bấm Cài đặt.',
      cards: [
        { icon: 'monitor', title: 'Windows', body: 'Tải tệp ZIP chạy trực tiếp, giải nén, bấm đúp. Node.js đã nằm sẵn bên trong; không cần chạm tới dòng lệnh.', href: '/docs#windows', go: 'Hướng dẫn Windows' },
        { icon: 'phone', title: 'Android · Termux', body: 'Ba khối lệnh để dán. Trình quản lý chạy ngay trên điện thoại và mở bằng trình duyệt của máy.', href: '/docs#android', go: 'Hướng dẫn Termux' },
        { icon: 'apple', title: 'macOS', body: 'Node.js 22, một lần clone, npm ci, rồi chạy launcher. Apple Silicon và Intel như nhau.', href: '/docs#macos', go: 'Hướng dẫn macOS' },
        { icon: 'server', title: 'Linux và VPS', body: 'Cùng launcher đó, kèm một unit systemd nếu bạn muốn nó tự chạy lại sau khi khởi động máy.', href: '/docs#linux', go: 'Hướng dẫn Linux' },
        { icon: 'box', title: 'Docker', body: 'Dựng image, gắn volume vào /data, mở cổng 7860 và 8001. Các nền tảng lưu trữ cũng làm tương tự.', href: '/docs#docker', go: 'Hướng dẫn Docker' },
        { icon: 'npm', title: 'npm', body: 'npx sillytavern-manager, hoặc cài toàn cục. Gói đã phát hành mang sẵn bảng điều khiển đã dựng.', href: '/docs#npm', go: 'Hướng dẫn npm' },
      ],
    },
    how: {
      eyebrow: 'Cách hoạt động',
      heading: 'Ba cổng, và hai cái link khác nhau',
      lede: 'SillyTavern không bao giờ là thứ bị mở ra ngoài. Thứ bạn chia sẻ là cổng truy cập — nó hỏi mã và không bao giờ chuyển tiếp trang quản trị. Bảng quản trị có link riêng của nó, nằm sau mật khẩu manager, cho lúc cái máy bạn cần không phải cái máy trước mặt.',
      caption: 'Link bạn chia sẻ dẫn tới cổng truy cập. Link riêng của bảng quản trị là một công tắc khác, và không phải để chia sẻ.',
      table: {
        columns: ['Cổng', 'Cái gì lắng nghe', 'Ai truy cập được'],
        rows: [
          ['7860', 'Bảng quản trị', 'Máy này, và chính bạn từ xa khi đã bật link riêng của nó'],
          ['8000', 'SillyTavern', 'Chỉ máy này'],
          ['8001', 'Cổng truy cập', 'Mạng nội bộ hoặc Cloudflare Tunnel, sau khi nhập mã'],
        ],
      },
      note: 'Link bạn đưa cho người khác mở cổng truy cập, không bao giờ mở bảng quản trị: ai cầm link đó cũng không cài, phục hồi hay xoá được gì. Mở bảng quản trị ra internet là công tắc thứ hai, nằm trong Cài đặt, và nó hỏi mật khẩu manager.',
    },
    screens: {
      eyebrow: 'Giao diện',
      heading: 'Nhìn một cái là hiểu',
      lede: 'Cùng một giao diện trên máy tính và điện thoại, ở chế độ sáng và tối, bằng tiếng Việt và tiếng Anh.',
      shots: [
        { name: 'data', alt: 'Trang dữ liệu: hồ sơ, bản sao lưu cục bộ và điểm phục hồi trên Cloudflare R2' },
        { name: 'metrics', alt: 'Trang mức dùng: lượt gọi, token, tỷ lệ trúng bộ nhớ đệm và độ trễ theo ngày, nhà cung cấp và mô hình' },
        { name: 'settings', alt: 'Trang cài đặt: bảo mật, hiệu năng, tiện ích mở rộng, API key và sao lưu chat' },
      ],
    },
    backups: {
      eyebrow: 'Sao lưu',
      heading: 'Dữ liệu của bạn, có thêm một bản ở nơi khác',
      lede: 'Bản lưu cục bộ luôn sẵn có. Đưa ra ngoài máy chỉ tốn một nút bấm, vào bucket trong chính tài khoản Cloudflare của bạn.',
      points: [
        { icon: 'archive', title: 'Tệp lưu tương thích', body: 'Một tệp ZIP dạng luồng mà chính chức năng nhập của SillyTavern đọc được. Mặc định loại trừ secret, và muốn kèm theo thì phải chủ động chọn kèm một cảnh báo.' },
        { icon: 'check', title: 'Phục hồi có xem trước', body: 'Tệp lưu được đọc và hiển thị trước khi có gì được ghi, và một bản chụp an toàn luôn được tạo trước khi ghi đè hay chuyển hồ sơ.' },
        { icon: 'cloud', title: 'Cloudflare của bạn, không phải của chúng tôi', body: 'Đăng nhập, chọn tài khoản, bucket được tạo ngay trong đó. Bản sao lưu đi thẳng từ máy bạn tới bucket của bạn; không máy chủ nào của dự án nằm trên đường đi.' },
      ],
      note: 'Sao lưu là công cụ, không phải bảo đảm. Hãy thử phục hồi một lần, và giữ ít nhất một bản sao không do trình quản lý tạo ra.',
    },
    privacy: {
      eyebrow: 'Quyền riêng tư',
      heading: 'Những gì bạn viết không bao giờ gửi về chúng tôi',
      body: [
        'Không có tài khoản, không có đám mây, và dự án không giữ bản sao dữ liệu nào của bạn. Đoạn chat, nhân vật, prompt, thiết lập, bản sao lưu và API key đều nằm trên máy do bạn kiểm soát.',
        'Trình quản lý gửi đi đúng một thứ: một bản tóm tắt sử dụng nhỏ nằm trong danh sách cho phép — nền tảng, phiên bản, và với mỗi lượt gọi là nhà cung cấp, tên mô hình, tên máy chủ điểm cuối, số token, mã trạng thái và thời lượng. Nó không bao giờ gửi prompt, đoạn chat, câu trả lời của mô hình, API key, tên tệp, đường dẫn, địa chỉ IP hay chuỗi truy vấn.',
        'Danh sách đầy đủ, và cách tắt hẳn việc gửi, nằm trong [Thông báo quyền riêng tư](/privacy).',
      ],
    },
    cta: {
      heading: 'Bắt đầu chỉ với một lần tải',
      lede: 'Không phải đăng ký gì. Bản Windows chạy trực tiếp; mọi nền tảng khác chỉ là một lần clone và một launcher.',
      primary: { href: RELEASES, label: 'Tải bản phát hành mới nhất', icon: 'download' },
      secondary: { href: '/docs', label: 'Đọc tài liệu trước đã', icon: 'book' },
    },
  },
};

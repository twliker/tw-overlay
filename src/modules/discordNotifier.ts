import * as https from 'https';
import * as url from 'url';
import * as config from './config';
import { log } from './logger';

class DiscordNotifier {
  /**
   * 디스코드 웹훅에 JSON payload를 전송합니다.
   */
  private sendWebhook(payload: any, overrideUrl?: string, overrideEnabled?: boolean): Promise<void> {
    return new Promise((resolve, reject) => {
      const cfg = config.load();
      const isEnabled = overrideEnabled !== undefined ? overrideEnabled : (cfg.discordAlertEnabled ?? false);
      const webhookUrl = (overrideUrl || cfg.discordWebhookUrl || '').trim();

      if (!isEnabled) {
        return resolve();
      }

      if (!webhookUrl) {
        return reject(new Error('Discord Webhook URL이 설정되지 않았습니다.'));
      }

      if (!webhookUrl.startsWith('https://')) {
        log(`[DISCORD] 유효하지 않은 웹훅 URL입니다. (https로 시작해야 함)`);
        return reject(new Error('Invalid Webhook URL (Must start with https://)'));
      }

      try {
        const parsedUrl = new url.URL(webhookUrl);
        const postData = JSON.stringify(payload);

        const options: https.RequestOptions = {
          hostname: parsedUrl.hostname,
          path: parsedUrl.pathname + parsedUrl.search,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(postData),
          },
        };

        const req = https.request(options, (res) => {
          let body = '';
          res.on('data', (chunk) => { body += chunk; });
          res.on('end', () => {
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              resolve();
            } else {
              log(`[DISCORD] 웹훅 전송 실패. 응답코드: ${res.statusCode}, 바디: ${body}`);
              reject(new Error(`HTTP Status Code: ${res.statusCode}`));
            }
          });
        });

        req.on('error', (err) => {
          log(`[DISCORD] 요청 에러: ${err.message}`);
          reject(err);
        });

        req.write(postData);
        req.end();
      } catch (e: any) {
        log(`[DISCORD] URL 분석 예외: ${e.message}`);
        reject(e);
      }
    });
  }



  /**
   * 지정 단어 알림 발송
   */
  public async sendWord(sender: string, message: string, matchedKeyword: string): Promise<void> {
    const cfg = config.load();

    const payload = {
      username: 'TW-Overlay 키워드 알리미',
      embeds: [
        {
          title: `💬 지정 단어 감지 [@${matchedKeyword}]`,
          description: `**${sender}**: ${message}`,
          color: 3447003, // 청색 (Blue)
          timestamp: new Date().toISOString(),
          footer: {
            text: 'TalesWeaver Companion (TW-Overlay)'
          }
        }
      ]
    };

    try {
      await this.sendWebhook(payload);
      log(`[DISCORD] 지정 단어 알림 웹훅 발송 성공: [${sender}] ${message}`);
    } catch (e: any) {
      log(`[DISCORD] 지정 단어 알림 웹훅 발송 실패: ${e.message}`);
    }
  }

  /**
   * 웹훅 연동 테스트 전송
   */
  public async sendTest(webhookUrl: string): Promise<void> {
    const payload = {
      username: 'TW-Overlay 테스트 봇',
      embeds: [
        {
          title: '🔔 디스코드 알림 연동 성공!',
          description: 'TW-Overlay와의 디스코드 웹훅 알림 연동 테스트가 성공적으로 완료되었습니다.',
          color: 3066993, // 녹색
          fields: [
            { name: '테스트 시간', value: new Date().toLocaleString('ko-KR') },
            { name: '작동 상태', value: '정상 (Online)' }
          ],
          timestamp: new Date().toISOString(),
          footer: {
            text: 'TalesWeaver Companion (TW-Overlay)'
          }
        }
      ]
    };

    // 설정 비활성화 상태여도 테스트는 강제로 전송 허용
    await this.sendWebhook(payload, webhookUrl, true);
  }
}

export const discordNotifier = new DiscordNotifier();

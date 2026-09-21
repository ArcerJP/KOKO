// 自動生成。変更はopenapi.yamlへ反映し npm run contract:generate を実行。
export interface paths {
  "/media/{event_id}/{post_id}/{resource}": {
    parameters: {
      query?: never;
      header?: never;
      path: {
        event_id: string;
        post_id: components["parameters"]["PostId"];
        /** @description BE生成の派生物識別子。上流URLや任意ホストは指定できない。 */
        resource: string;
      };
      cookie?: never;
    };
    /**
     * セッションを毎回検証して派生画像・動画・サムネイルを配信
     * @description JWT/セッション→イベント/投稿の現在の公開可否→内部キャッシュの順に検査。
     *     ブラウザへはprivate, no-storeを返す。認証トークンをURLへ入れない。
     *     Streamは常時requireSignedURLs=true。上流署名はサーバー内限定で、redirectしない。
     *     HLS子playlist/segment/key/mapもこのゲートへ書き換え、全取得で認証する。
     *     Cookieは同一origin経由。Range/Content-Rangeと有効期限切れを実機検証する。
     *     将来のnativeは設定済みHTTPS originにパスを解決し、全子リソースにも認証を付与する。
     *     相対パスを一般公開URLやトークン付きURLに置き換えない。
     *     審査用resourceでは追加のmoderator/admin権限と目的を検証し、原本は配信しない。
     */
    get: operations["getAuthenticatedMedia"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/me": {
    parameters: {
      query?: never;
      header: {
        /** @description イベントID。所有者IDやroleは受け取らない。 */
        "X-Event-ID": components["parameters"]["EventId"];
        /** @description Cookie認証の書込みでは必須。GET/HEADとBearer認証では不要。GET /meで取得するセッション束縛値。 */
        "X-CSRF-Token"?: components["parameters"]["CsrfToken"];
      };
      path?: never;
      cookie?: never;
    };
    /** 本人の権限・BAN・同意状態を取得 */
    get: operations["getMe"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    /** 表示名だけを変更（アバター・roleは受け付けない） */
    patch: operations["updateMe"];
    trace?: never;
  };
  "/consents": {
    parameters: {
      query?: never;
      header: {
        /** @description イベントID。所有者IDやroleは受け取らない。 */
        "X-Event-ID": components["parameters"]["EventId"];
        /** @description Cookie認証の書込みでは必須。GET/HEADとBearer認証では不要。GET /meで取得するセッション束縛値。 */
        "X-CSRF-Token"?: components["parameters"]["CsrfToken"];
      };
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** 現行規約への明示同意をサーバー時刻とともに保存 */
    post: operations["acceptTerms"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/uploads": {
    parameters: {
      query?: never;
      header: {
        /** @description イベントID。所有者IDやroleは受け取らない。 */
        "X-Event-ID": components["parameters"]["EventId"];
        /** @description Cookie認証の書込みでは必須。GET/HEADとBearer認証では不要。GET /meで取得するセッション束縛値。 */
        "X-CSRF-Token"?: components["parameters"]["CsrfToken"];
      };
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /**
     * 投稿IDとR2原本への直接アップロード情報を払い出す
     * @description 同意・BAN・受付・10件/分を検証。client_request_idはイベントと本人で一意。
     *     同一ID・同一内容の再送は同じ投稿を返し、異なる内容はIDEMPOTENCY_CONFLICT。
     *     file_size_bytesに業務独自上限を設けず、R2の上限とmultipartを利用する。
     *     署名URLは限定されたPUT専用で、原本を閲覧する権限を含まない。
     */
    post: operations["createUpload"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/uploads/{upload_id}/refresh": {
    parameters: {
      query?: never;
      header: {
        /** @description イベントID。所有者IDやroleは受け取らない。 */
        "X-Event-ID": components["parameters"]["EventId"];
        /** @description Cookie認証の書込みでは必須。GET/HEADとBearer認証では不要。GET /meで取得するセッション束縛値。 */
        "X-CSRF-Token"?: components["parameters"]["CsrfToken"];
      };
      path: {
        upload_id: components["parameters"]["UploadId"];
      };
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** 所有者の未完了アップロードURLを再発行 */
    post: operations["refreshUpload"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/uploads/{upload_id}/parts": {
    parameters: {
      query?: never;
      header: {
        /** @description イベントID。所有者IDやroleは受け取らない。 */
        "X-Event-ID": components["parameters"]["EventId"];
        /** @description Cookie認証の書込みでは必須。GET/HEADとBearer認証では不要。GET /meで取得するセッション束縛値。 */
        "X-CSRF-Token"?: components["parameters"]["CsrfToken"];
      };
      path: {
        upload_id: components["parameters"]["UploadId"];
      };
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** multipartの指定パートへ限定したPUT URLを発行 */
    post: operations["signUploadParts"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/posts/{post_id}/complete": {
    parameters: {
      query?: never;
      header: {
        /** @description イベントID。所有者IDやroleは受け取らない。 */
        "X-Event-ID": components["parameters"]["EventId"];
        /** @description Cookie認証の書込みでは必須。GET/HEADとBearer認証では不要。GET /meで取得するセッション束縛値。 */
        "X-CSRF-Token"?: components["parameters"]["CsrfToken"];
      };
      path: {
        post_id: components["parameters"]["PostId"];
      };
      cookie?: never;
    };
    get?: never;
    put?: never;
    /**
     * R2への原本保存を検証して処理キューへ登録
     * @description 本人とupload_idの所属を検証し、multipartならETag一覧で完了、HEADで実在・サイズを確認。
     *     本文のMIMEや完了申告だけを信用しない。再実行は同じ処理IDを返し二重処理しない。
     */
    post: operations["completeUpload"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/posts/{post_id}/status": {
    parameters: {
      query?: never;
      header: {
        /** @description イベントID。所有者IDやroleは受け取らない。 */
        "X-Event-ID": components["parameters"]["EventId"];
        /** @description Cookie認証の書込みでは必須。GET/HEADとBearer認証では不要。GET /meで取得するセッション束縛値。 */
        "X-CSRF-Token"?: components["parameters"]["CsrfToken"];
      };
      path: {
        post_id: components["parameters"]["PostId"];
      };
      cookie?: never;
    };
    /** 本人のアップロード・処理結果を確認 */
    get: operations["getPostStatus"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/posts/{post_id}": {
    parameters: {
      query?: never;
      header: {
        /** @description イベントID。所有者IDやroleは受け取らない。 */
        "X-Event-ID": components["parameters"]["EventId"];
        /** @description Cookie認証の書込みでは必須。GET/HEADとBearer認証では不要。GET /meで取得するセッション束縛値。 */
        "X-CSRF-Token"?: components["parameters"]["CsrfToken"];
      };
      path: {
        post_id: components["parameters"]["PostId"];
      };
      cookie?: never;
    };
    /**
     * 現在公開可能な投稿を取得
     * @description 非公開・削除・他イベントを区別せず404。JWT検証と公開停止判定をキャッシュ参照前に行う。
     */
    get: operations["getPost"];
    put?: never;
    post?: never;
    /**
     * 本人の投稿を論理削除し配信停止と物理削除を予約
     * @description 冪等。原本lock中は物理削除を延期し、deletedと区別して記録する。
     */
    delete: operations["deleteOwnPost"];
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/feed": {
    parameters: {
      query?: {
        cursor?: components["parameters"]["Cursor"];
        limit?: components["parameters"]["Limit"];
        theme?: string;
      };
      header: {
        /** @description イベントID。所有者IDやroleは受け取らない。 */
        "X-Event-ID": components["parameters"]["EventId"];
      };
      path?: never;
      cookie?: never;
    };
    /**
     * 公開投稿の新着一覧をキーセットで取得
     * @description created_at DESC, id DESC。cursorはイベント・theme・並び順に束縛された不透明値。
     *     JWTと公開停止を検証してからエッジ共有キャッシュ（約10秒）へ進む。
     *     HTTPレスポンスはprivate, no-storeとし、共有キャッシュはWorker内部だけ。
     *     ユーザー固有のliked状態・role・メール・原本情報を含めない。通常10〜15秒で再取得。
     */
    get: operations["getFeed"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/themes": {
    parameters: {
      query?: never;
      header: {
        /** @description イベントID。所有者IDやroleは受け取らない。 */
        "X-Event-ID": components["parameters"]["EventId"];
        /** @description Cookie認証の書込みでは必須。GET/HEADとBearer認証では不要。GET /meで取得するセッション束縛値。 */
        "X-CSRF-Token"?: components["parameters"]["CsrfToken"];
      };
      path?: never;
      cookie?: never;
    };
    /** 公開中・終了済みのお題を取得 */
    get: operations["listThemes"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/me/posts": {
    parameters: {
      query?: {
        cursor?: components["parameters"]["Cursor"];
        limit?: components["parameters"]["Limit"];
      };
      header: {
        /** @description イベントID。所有者IDやroleは受け取らない。 */
        "X-Event-ID": components["parameters"]["EventId"];
      };
      path?: never;
      cookie?: never;
    };
    /** 本人の投稿状態一覧を取得（非公開投稿を含む、原本URLなし） */
    get: operations["listOwnPosts"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/posts/{post_id}/reports": {
    parameters: {
      query?: never;
      header: {
        /** @description イベントID。所有者IDやroleは受け取らない。 */
        "X-Event-ID": components["parameters"]["EventId"];
        /** @description Cookie認証の書込みでは必須。GET/HEADとBearer認証では不要。GET /meで取得するセッション束縛値。 */
        "X-CSRF-Token"?: components["parameters"]["CsrfToken"];
      };
      path: {
        post_id: components["parameters"]["PostId"];
      };
      cookie?: never;
    };
    get?: never;
    put?: never;
    /**
     * 1件目で非表示・2件目で追加通知（本人の重複は数えない）
     * @description DB更新と配信停止outboxを同一transactionにする。通報後の他の通報者も
     *     同じイベントの既知IDへ通報できるが、投稿内容は返さず一律受付応答とする。
     */
    post: operations["reportPost"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/appeals": {
    parameters: {
      query?: never;
      header: {
        /** @description イベントID。所有者IDやroleは受け取らない。 */
        "X-Event-ID": components["parameters"]["EventId"];
        /** @description Cookie認証の書込みでは必須。GET/HEADとBearer認証では不要。GET /meで取得するセッション束縛値。 */
        "X-CSRF-Token"?: components["parameters"]["CsrfToken"];
      };
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** 本人のBLOCKまたはBANについて異議申立て（BAN中も利用可） */
    post: operations["createAppeal"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/admin/feed": {
    parameters: {
      query?: {
        cursor?: components["parameters"]["Cursor"];
        limit?: components["parameters"]["Limit"];
      };
      header: {
        /** @description イベントID。所有者IDやroleは受け取らない。 */
        "X-Event-ID": components["parameters"]["EventId"];
      };
      path?: never;
      cookie?: never;
    };
    /** moderator以上が監視用投稿状態を取得（FLAG・通報を優先） */
    get: operations["getAdminFeed"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/admin/posts/{post_id}/hide": {
    parameters: {
      query?: never;
      header: {
        /** @description イベントID。所有者IDやroleは受け取らない。 */
        "X-Event-ID": components["parameters"]["EventId"];
        /** @description Cookie認証の書込みでは必須。GET/HEADとBearer認証では不要。GET /meで取得するセッション束縛値。 */
        "X-CSRF-Token"?: components["parameters"]["CsrfToken"];
      };
      path: {
        post_id: components["parameters"]["PostId"];
      };
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** moderator以上が公開投稿を非表示にする */
    post: operations["hidePost"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/admin/posts/{post_id}/restore": {
    parameters: {
      query?: never;
      header: {
        /** @description イベントID。所有者IDやroleは受け取らない。 */
        "X-Event-ID": components["parameters"]["EventId"];
        /** @description Cookie認証の書込みでは必須。GET/HEADとBearer認証では不要。GET /meで取得するセッション束縛値。 */
        "X-CSRF-Token"?: components["parameters"]["CsrfToken"];
      };
      path: {
        post_id: components["parameters"]["PostId"];
      };
      cookie?: never;
    };
    get?: never;
    put?: never;
    /**
     * moderator以上が非表示を解除（BLOCK・BAN・公開停止は解除不可）
     * @description 保存済み判定と以前の公開状態を使用し、バージョン一致と配信準備を検証する。
     */
    post: operations["restorePost"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/admin/posts/{post_id}/delete": {
    parameters: {
      query?: never;
      header: {
        /** @description イベントID。所有者IDやroleは受け取らない。 */
        "X-Event-ID": components["parameters"]["EventId"];
        /** @description Cookie認証の書込みでは必須。GET/HEADとBearer認証では不要。GET /meで取得するセッション束縛値。 */
        "X-CSRF-Token"?: components["parameters"]["CsrfToken"];
      };
      path: {
        post_id: components["parameters"]["PostId"];
      };
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** moderator以上が論理削除と配信停止・削除ジョブを登録 */
    post: operations["deletePost"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/admin/posts/{post_id}/theme": {
    parameters: {
      query?: never;
      header: {
        /** @description イベントID。所有者IDやroleは受け取らない。 */
        "X-Event-ID": components["parameters"]["EventId"];
        /** @description Cookie認証の書込みでは必須。GET/HEADとBearer認証では不要。GET /meで取得するセッション束縛値。 */
        "X-CSRF-Token"?: components["parameters"]["CsrfToken"];
      };
      path: {
        post_id: components["parameters"]["PostId"];
      };
      cookie?: never;
    };
    get?: never;
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    /** adminがお題を付け替え・解除する */
    patch: operations["reassignTheme"];
    trace?: never;
  };
  "/admin/users/{user_id}/ban": {
    parameters: {
      query?: never;
      header: {
        /** @description イベントID。所有者IDやroleは受け取らない。 */
        "X-Event-ID": components["parameters"]["EventId"];
        /** @description Cookie認証の書込みでは必須。GET/HEADとBearer認証では不要。GET /meで取得するセッション束縛値。 */
        "X-CSRF-Token"?: components["parameters"]["CsrfToken"];
      };
      path: {
        user_id: components["parameters"]["UserId"];
      };
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** adminがイベント内の利用者をBANし過去投稿を非公開にする */
    post: operations["banUser"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/admin/users/{user_id}/unban": {
    parameters: {
      query?: never;
      header: {
        /** @description イベントID。所有者IDやroleは受け取らない。 */
        "X-Event-ID": components["parameters"]["EventId"];
        /** @description Cookie認証の書込みでは必須。GET/HEADとBearer認証では不要。GET /meで取得するセッション束縛値。 */
        "X-CSRF-Token"?: components["parameters"]["CsrfToken"];
      };
      path: {
        user_id: components["parameters"]["UserId"];
      };
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** adminがBANを解除（過去投稿の公開復帰とは別操作） */
    post: operations["unbanUser"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/admin/settings": {
    parameters: {
      query?: never;
      header: {
        /** @description イベントID。所有者IDやroleは受け取らない。 */
        "X-Event-ID": components["parameters"]["EventId"];
        /** @description Cookie認証の書込みでは必須。GET/HEADとBearer認証では不要。GET /meで取得するセッション束縛値。 */
        "X-CSRF-Token"?: components["parameters"]["CsrfToken"];
      };
      path?: never;
      cookie?: never;
    };
    /** adminが公開停止・受付・モデレーション設定を取得 */
    get: operations["getSettings"];
    /** adminが設定をバージョン一致で更新（キルスイッチは受付も止める） */
    put: operations["updateSettings"];
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/admin/themes": {
    parameters: {
      query?: never;
      header: {
        /** @description イベントID。所有者IDやroleは受け取らない。 */
        "X-Event-ID": components["parameters"]["EventId"];
        /** @description Cookie認証の書込みでは必須。GET/HEADとBearer認証では不要。GET /meで取得するセッション束縛値。 */
        "X-CSRF-Token"?: components["parameters"]["CsrfToken"];
      };
      path?: never;
      cookie?: never;
    };
    /** adminが下書きを含むお題を取得 */
    get: operations["listAdminThemes"];
    put?: never;
    /** adminがお題を作成 */
    post: operations["createTheme"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/admin/themes/{theme_id}": {
    parameters: {
      query?: never;
      header: {
        /** @description イベントID。所有者IDやroleは受け取らない。 */
        "X-Event-ID": components["parameters"]["EventId"];
        /** @description Cookie認証の書込みでは必須。GET/HEADとBearer認証では不要。GET /meで取得するセッション束縛値。 */
        "X-CSRF-Token"?: components["parameters"]["CsrfToken"];
      };
      path: {
        theme_id: string;
      };
      cookie?: never;
    };
    get?: never;
    /** adminがお題を編集・公開・終了 */
    put: operations["updateTheme"];
    post?: never;
    /** adminが未使用のお題を削除（使用済みは終了にする） */
    delete: operations["deleteTheme"];
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/admin/appeals": {
    parameters: {
      query?: {
        cursor?: components["parameters"]["Cursor"];
        limit?: components["parameters"]["Limit"];
      };
      header: {
        /** @description イベントID。所有者IDやroleは受け取らない。 */
        "X-Event-ID": components["parameters"]["EventId"];
      };
      path?: never;
      cookie?: never;
    };
    /** adminが異議申立て一覧を取得 */
    get: operations["listAppeals"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/admin/appeals/{appeal_id}": {
    parameters: {
      query?: never;
      header: {
        /** @description イベントID。所有者IDやroleは受け取らない。 */
        "X-Event-ID": components["parameters"]["EventId"];
        /** @description Cookie認証の書込みでは必須。GET/HEADとBearer認証では不要。GET /meで取得するセッション束縛値。 */
        "X-CSRF-Token"?: components["parameters"]["CsrfToken"];
      };
      path: {
        appeal_id: string;
      };
      cookie?: never;
    };
    get?: never;
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    /** adminが異議申立ての対応結果を記録（復元・BAN解除は別操作） */
    patch: operations["resolveAppeal"];
    trace?: never;
  };
  "/posts/{post_id}/like": {
    parameters: {
      query?: never;
      header: {
        /** @description イベントID。所有者IDやroleは受け取らない。 */
        "X-Event-ID": components["parameters"]["EventId"];
        /** @description Cookie認証の書込みでは必須。GET/HEADとBearer認証では不要。GET /meで取得するセッション束縛値。 */
        "X-CSRF-Token"?: components["parameters"]["CsrfToken"];
      };
      path: {
        post_id: components["parameters"]["PostId"];
      };
      cookie?: never;
    };
    get?: never;
    /** いいねを付ける（冪等、本人とイベントで一意） */
    put: operations["likePost"];
    post?: never;
    /** いいねを取り消す（冪等） */
    delete: operations["unlikePost"];
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/me/likes": {
    parameters: {
      query?: {
        cursor?: components["parameters"]["Cursor"];
        limit?: components["parameters"]["Limit"];
      };
      header: {
        /** @description イベントID。所有者IDやroleは受け取らない。 */
        "X-Event-ID": components["parameters"]["EventId"];
      };
      path?: never;
      cookie?: never;
    };
    /** 個人のいいね状態を共有キャッシュとは分離して取得 */
    get: operations["listOwnLikes"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/admin/failures": {
    parameters: {
      query?: {
        cursor?: components["parameters"]["Cursor"];
        limit?: components["parameters"]["Limit"];
      };
      header: {
        /** @description イベントID。所有者IDやroleは受け取らない。 */
        "X-Event-ID": components["parameters"]["EventId"];
      };
      path?: never;
      cookie?: never;
    };
    /** adminが処理失敗を取得（当日はBE運用スクリプトで代替） */
    get: operations["listFailures"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/admin/posts/{post_id}/retry": {
    parameters: {
      query?: never;
      header: {
        /** @description イベントID。所有者IDやroleは受け取らない。 */
        "X-Event-ID": components["parameters"]["EventId"];
        /** @description Cookie認証の書込みでは必須。GET/HEADとBearer認証では不要。GET /meで取得するセッション束縛値。 */
        "X-CSRF-Token"?: components["parameters"]["CsrfToken"];
      };
      path: {
        post_id: components["parameters"]["PostId"];
      };
      cookie?: never;
    };
    get?: never;
    put?: never;
    /**
     * adminが保留・BLOCKの再判定を予約（公開を直接承認しない）
     * @description 当日は同じ契約をBEの運用スクリプトから使用。自動再試行上限とは分離する。
     */
    post: operations["retryProcessing"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/admin/stats": {
    parameters: {
      query?: never;
      header: {
        /** @description イベントID。所有者IDやroleは受け取らない。 */
        "X-Event-ID": components["parameters"]["EventId"];
        /** @description Cookie認証の書込みでは必須。GET/HEADとBearer認証では不要。GET /meで取得するセッション束縛値。 */
        "X-CSRF-Token"?: components["parameters"]["CsrfToken"];
      };
      path?: never;
      cookie?: never;
    };
    /** adminがイベントの投稿・通報・容量・配信量を取得 */
    get: operations["getStats"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/admin/moderation-logs": {
    parameters: {
      query?: {
        cursor?: components["parameters"]["Cursor"];
        limit?: components["parameters"]["Limit"];
      };
      header: {
        /** @description イベントID。所有者IDやroleは受け取らない。 */
        "X-Event-ID": components["parameters"]["EventId"];
      };
      path?: never;
      cookie?: never;
    };
    /**
     * adminが判定ログを取得し集計・CSVへ利用
     * @description スコア・モデル・時間・費用のみ。画像やOCR全文は含めない。
     */
    get: operations["listModerationLogs"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
}
export type webhooks = Record<string, never>;
export interface components {
  schemas: {
    ApiError: {
      /** @enum {string} */
      code:
        | "AUTH_REQUIRED"
        | "FORBIDDEN"
        | "CONSENT_REQUIRED"
        | "ACCOUNT_BANNED"
        | "NOT_FOUND"
        | "INVALID_INPUT"
        | "INVALID_CURSOR"
        | "EVENT_CLOSED"
        | "PUBLICATION_STOPPED"
        | "THEME_UNAVAILABLE"
        | "STATE_CONFLICT"
        | "IDEMPOTENCY_CONFLICT"
        | "RATE_LIMITED"
        | "UPLOAD_EXPIRED"
        | "UPLOAD_INCOMPLETE"
        | "PROVIDER_LIMIT"
        | "UNSUPPORTED_MEDIA"
        | "VIDEO_TOO_LONG"
        | "PROCESSING_HELD"
        | "CONTENT_BLOCKED"
        | "INTERNAL_ERROR";
      /** Format: uuid */
      request_id: string;
      retry_after_seconds?: number;
    };
    Acknowledgement: {
      /** Format: uuid */
      request_id: string;
      /** Format: uuid */
      resource_id?: string;
    };
    Me: {
      /** Format: uuid */
      user_id: string;
      /** Format: uuid */
      event_id: string;
      display_name: string;
      /** @enum {string} */
      role: "user" | "moderator" | "admin";
      is_banned: boolean;
      terms_version: string;
      consent_required: boolean;
      /** @description Cookieセッション時のみ返す。保存/ログ/共有cacheは禁止。 */
      csrf_token?: string;
      /**
       * @description 第4要件まではnone
       * @enum {string}
       */
      crown: "none" | "white" | "gold";
    };
    UploadRequest: {
      /** Format: uuid */
      client_request_id: string;
      /** @enum {string} */
      kind: "photo" | "video";
      content_type: string;
      /** @description 業務独自の上限は設けない。プロバイダー制約はPROVIDER_LIMIT。 */
      file_size_bytes: number;
      /** @enum {string} */
      original_scope: "photo_file" | "client_trimmed" | "full_video_fallback";
      /** Format: uuid */
      theme_id?: string | null;
    };
    UploadTicket: {
      /** Format: uuid */
      post_id: string;
      /** Format: uuid */
      upload_id: string;
      /** @enum {string} */
      mode: "single" | "multipart";
      /** Format: date-time */
      expires_at: string;
      /**
       * Format: uri
       * @description single時のみ。ログへ保存しない。
       */
      put_url?: string;
      required_headers?: {
        [key: string]: string;
      };
      /** @description multipart時のみ。末尾以外のパートサイズ。 */
      part_size_bytes?: number;
    } & (
      | {
          /** @constant */
          mode: "single";
        }
      | {
          /** @constant */
          mode: "multipart";
        }
    );
    /** @enum {string} */
    State:
      | "uploading"
      | "upload_failed"
      | "uploaded"
      | "processing"
      | "published"
      | "published_flagged"
      | "blocked"
      | "held"
      | "hidden"
      | "deleted";
    PostStatus: {
      /** Format: uuid */
      id: string;
      /** Format: uuid */
      event_id: string;
      status: components["schemas"]["State"];
      version: number;
      /** Format: date-time */
      created_at: string;
      error_code?: components["schemas"]["ApiError"]["code"];
      /** @description 本人向けの大分類のみ。生スコア・OCR文・モデル内部情報は返さない。 */
      block_category?: string;
    };
    /** @description アプリ内で公開済みの投稿。匿名アクセス可能という意味ではない。 */
    PublicPost: {
      /** Format: uuid */
      id: string;
      /** Format: uuid */
      event_id: string;
      /** @enum {string} */
      kind: "photo" | "video";
      display_name: string;
      /** @enum {string} */
      crown: "none" | "white" | "gold";
      /** Format: uuid */
      theme_id: string | null;
      /** Format: date-time */
      created_at: string;
      /** @description 第4要件までは0 */
      like_count: number;
      media:
        | components["schemas"]["PhotoDelivery"]
        | components["schemas"]["VideoDelivery"];
    } & (
      | {
          /** @constant */
          kind: "photo";
          media: components["schemas"]["PhotoDelivery"];
        }
      | {
          /** @constant */
          kind: "video";
          media: components["schemas"]["VideoDelivery"];
        }
    );
    PhotoDelivery: {
      /** @constant */
      kind: "photo";
      webp_600: string;
      jpg_600: string;
      webp_1600: string;
      jpg_1600: string;
    };
    VideoDelivery: {
      /** @constant */
      kind: "video";
      hls_url: string;
      thumbnail_url: string;
      /** @description 第2要件の実機スパイクで採用した場合だけ返す */
      mp4_url?: string;
      duration_seconds: number;
    };
    PostPage: {
      items: components["schemas"]["PublicPost"][];
      next_cursor: string | null;
    };
    AdminPostPage: {
      items: {
        post: components["schemas"]["PostStatus"];
        /** Format: uuid */
        user_id: string;
        report_count: number;
        is_banned: boolean;
        /** @description 運営権限も毎回検証する審査用派生物。原本ではない。BLOCKは既定で返さない。 */
        preview_url?: string;
      }[];
      next_cursor: string | null;
    };
    AdminAction: {
      expected_version: number;
      reason: string;
    };
    ThemeInput: components["schemas"]["ThemeFields"];
    ThemeFields: {
      title: string;
      description: string;
      icon: string;
      color: string;
      /** @enum {string} */
      status: "draft" | "published" | "ended";
      /** Format: date-time */
      starts_at: string;
      /** Format: date-time */
      ends_at: string;
    };
    Theme: components["schemas"]["ThemeFields"] & {
      /** Format: uuid */
      id: string;
      /** Format: uuid */
      event_id: string;
    };
    Settings: {
      /** @description PUTではexpected versionとして比較し成功時に加算 */
      version: number;
      publication_stopped: boolean;
      uploads_enabled: boolean;
      moderation_concurrency: number;
      /** @description 各エンジンのアダプターが正規化した0〜1スコア用。flagがblock以下であることを検証し、更新を監査。DBのmoderation_thresholdsへ配列として保存。 */
      thresholds: {
        /** @enum {string} */
        engine: "openai" | "safesearch" | "ocr";
        category: string;
        flag: number;
        block: number;
        /** @description 重大カテゴリだけ許可。管理者による校正が必須。 */
        immediate_ban: boolean;
      }[];
    };
    Appeal: {
      /** Format: uuid */
      id: string;
      /** Format: uuid */
      user_id: string;
      /** Format: uuid */
      post_id: string | null;
      message: string;
      /** @enum {string} */
      status: "open" | "resolved" | "rejected";
      /** Format: date-time */
      created_at: string;
    };
    Stats: {
      /** Format: uuid */
      event_id: string;
      /** Format: date-time */
      measured_at: string;
      posts: number;
      published: number;
      reports: number;
      original_bytes: number | null;
      stream_delivery_minutes: number | null;
      videos_over_four_seconds: number;
    };
    ModerationLog: {
      /** Format: uuid */
      id: string;
      /** Format: uuid */
      post_id: string;
      /** @enum {string} */
      engine: "openai" | "safesearch" | "ocr";
      model_version: string;
      /** @enum {string} */
      decision: "PASS" | "FLAG" | "BLOCK" | "ERROR";
      scores: {
        [key: string]: number;
      };
      latency_ms: number | null;
      estimated_cost_usd: number | null;
      /** Format: date-time */
      created_at: string;
    };
  };
  responses: {
    /** @description src/errors.tsに対応するエラー。機密・内部例外を含めない。 */
    Error: {
      headers: {
        /** @description 再試行可能な場合の待機秒数 */
        "Retry-After"?: number;
        [name: string]: unknown;
      };
      content: {
        "application/json": components["schemas"]["ApiError"];
      };
    };
  };
  parameters: {
    /** @description Cookie認証の書込みでは必須。GET/HEADとBearer認証では不要。GET /meで取得するセッション束縛値。 */
    CsrfToken: string;
    /** @description イベントID。所有者IDやroleは受け取らない。 */
    EventId: string;
    PostId: string;
    UserId: string;
    UploadId: string;
    Cursor: string;
    Limit: number;
  };
  requestBodies: never;
  headers: never;
  pathItems: never;
}
export type $defs = Record<string, never>;
export interface operations {
  getAuthenticatedMedia: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        event_id: string;
        post_id: components["parameters"]["PostId"];
        /** @description BE生成の派生物識別子。上流URLや任意ホストは指定できない。 */
        resource: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description 認証済みメディア。Content-Typeは実メディア型、nosniff、private/no-store。 */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/octet-stream": string;
          "application/vnd.apple.mpegurl": string;
        };
      };
      /** @description 検証済み単一Rangeへの部分応答。Content-Range/Accept-Rangesを付与。 */
      206: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/octet-stream": string;
        };
      };
      401: components["responses"]["Error"];
      default: components["responses"]["Error"];
    };
  };
  getMe: {
    parameters: {
      query?: never;
      header: {
        /** @description イベントID。所有者IDやroleは受け取らない。 */
        "X-Event-ID": components["parameters"]["EventId"];
        /** @description Cookie認証の書込みでは必須。GET/HEADとBearer認証では不要。GET /meで取得するセッション束縛値。 */
        "X-CSRF-Token"?: components["parameters"]["CsrfToken"];
      };
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description 本人情報。Cache-Controlはprivate, no-store。 */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["Me"];
        };
      };
      401: components["responses"]["Error"];
      default: components["responses"]["Error"];
    };
  };
  updateMe: {
    parameters: {
      query?: never;
      header: {
        /** @description イベントID。所有者IDやroleは受け取らない。 */
        "X-Event-ID": components["parameters"]["EventId"];
        /** @description Cookie認証の書込みでは必須。GET/HEADとBearer認証では不要。GET /meで取得するセッション束縛値。 */
        "X-CSRF-Token"?: components["parameters"]["CsrfToken"];
      };
      path?: never;
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": {
          display_name: string;
        };
      };
    };
    responses: {
      /** @description 処理完了 */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["Acknowledgement"];
        };
      };
      401: components["responses"]["Error"];
      default: components["responses"]["Error"];
    };
  };
  acceptTerms: {
    parameters: {
      query?: never;
      header: {
        /** @description イベントID。所有者IDやroleは受け取らない。 */
        "X-Event-ID": components["parameters"]["EventId"];
        /** @description Cookie認証の書込みでは必須。GET/HEADとBearer認証では不要。GET /meで取得するセッション束縛値。 */
        "X-CSRF-Token"?: components["parameters"]["CsrfToken"];
      };
      path?: never;
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": {
          terms_version: string;
          /** @constant */
          accepted: true;
        };
      };
    };
    responses: {
      /** @description 処理完了 */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["Acknowledgement"];
        };
      };
      401: components["responses"]["Error"];
      default: components["responses"]["Error"];
    };
  };
  createUpload: {
    parameters: {
      query?: never;
      header: {
        /** @description イベントID。所有者IDやroleは受け取らない。 */
        "X-Event-ID": components["parameters"]["EventId"];
        /** @description Cookie認証の書込みでは必須。GET/HEADとBearer認証では不要。GET /meで取得するセッション束縛値。 */
        "X-CSRF-Token"?: components["parameters"]["CsrfToken"];
      };
      path?: never;
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["UploadRequest"];
      };
    };
    responses: {
      /** @description 新規または再取得した送信情報。no-store。 */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["UploadTicket"];
        };
      };
      401: components["responses"]["Error"];
      default: components["responses"]["Error"];
    };
  };
  refreshUpload: {
    parameters: {
      query?: never;
      header: {
        /** @description イベントID。所有者IDやroleは受け取らない。 */
        "X-Event-ID": components["parameters"]["EventId"];
        /** @description Cookie認証の書込みでは必須。GET/HEADとBearer認証では不要。GET /meで取得するセッション束縛値。 */
        "X-CSRF-Token"?: components["parameters"]["CsrfToken"];
      };
      path: {
        upload_id: components["parameters"]["UploadId"];
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description 新規または再取得した送信情報。no-store。 */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["UploadTicket"];
        };
      };
      401: components["responses"]["Error"];
      default: components["responses"]["Error"];
    };
  };
  signUploadParts: {
    parameters: {
      query?: never;
      header: {
        /** @description イベントID。所有者IDやroleは受け取らない。 */
        "X-Event-ID": components["parameters"]["EventId"];
        /** @description Cookie認証の書込みでは必須。GET/HEADとBearer認証では不要。GET /meで取得するセッション束縛値。 */
        "X-CSRF-Token"?: components["parameters"]["CsrfToken"];
      };
      path: {
        upload_id: components["parameters"]["UploadId"];
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": {
          part_numbers: number[];
        };
      };
    };
    responses: {
      /** @description パートURL。ETagをクライアントに公開するCORS設定が必要。 */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": {
            parts: {
              part_number: number;
              /** Format: uri */
              put_url: string;
              /** Format: date-time */
              expires_at: string;
            }[];
          };
        };
      };
      401: components["responses"]["Error"];
      default: components["responses"]["Error"];
    };
  };
  completeUpload: {
    parameters: {
      query?: never;
      header: {
        /** @description イベントID。所有者IDやroleは受け取らない。 */
        "X-Event-ID": components["parameters"]["EventId"];
        /** @description Cookie認証の書込みでは必須。GET/HEADとBearer認証では不要。GET /meで取得するセッション束縛値。 */
        "X-CSRF-Token"?: components["parameters"]["CsrfToken"];
      };
      path: {
        post_id: components["parameters"]["PostId"];
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": {
          /** Format: uuid */
          upload_id: string;
          parts?: {
            part_number: number;
            etag: string;
          }[];
        };
      };
    };
    responses: {
      /** @description 本人向け投稿状態。no-store。 */
      202: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["PostStatus"];
        };
      };
      401: components["responses"]["Error"];
      default: components["responses"]["Error"];
    };
  };
  getPostStatus: {
    parameters: {
      query?: never;
      header: {
        /** @description イベントID。所有者IDやroleは受け取らない。 */
        "X-Event-ID": components["parameters"]["EventId"];
        /** @description Cookie認証の書込みでは必須。GET/HEADとBearer認証では不要。GET /meで取得するセッション束縛値。 */
        "X-CSRF-Token"?: components["parameters"]["CsrfToken"];
      };
      path: {
        post_id: components["parameters"]["PostId"];
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description 本人向け投稿状態。no-store。 */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["PostStatus"];
        };
      };
      401: components["responses"]["Error"];
      default: components["responses"]["Error"];
    };
  };
  getPost: {
    parameters: {
      query?: never;
      header: {
        /** @description イベントID。所有者IDやroleは受け取らない。 */
        "X-Event-ID": components["parameters"]["EventId"];
        /** @description Cookie認証の書込みでは必須。GET/HEADとBearer認証では不要。GET /meで取得するセッション束縛値。 */
        "X-CSRF-Token"?: components["parameters"]["CsrfToken"];
      };
      path: {
        post_id: components["parameters"]["PostId"];
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description 公開用派生物だけを含む投稿 */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["PublicPost"];
        };
      };
      401: components["responses"]["Error"];
      default: components["responses"]["Error"];
    };
  };
  deleteOwnPost: {
    parameters: {
      query?: never;
      header: {
        /** @description イベントID。所有者IDやroleは受け取らない。 */
        "X-Event-ID": components["parameters"]["EventId"];
        /** @description Cookie認証の書込みでは必須。GET/HEADとBearer認証では不要。GET /meで取得するセッション束縛値。 */
        "X-CSRF-Token"?: components["parameters"]["CsrfToken"];
      };
      path: {
        post_id: components["parameters"]["PostId"];
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description 処理完了 */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["Acknowledgement"];
        };
      };
      401: components["responses"]["Error"];
      default: components["responses"]["Error"];
    };
  };
  getFeed: {
    parameters: {
      query?: {
        cursor?: components["parameters"]["Cursor"];
        limit?: components["parameters"]["Limit"];
        theme?: string;
      };
      header: {
        /** @description イベントID。所有者IDやroleは受け取らない。 */
        "X-Event-ID": components["parameters"]["EventId"];
      };
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description 投稿ページ */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["PostPage"];
        };
      };
      401: components["responses"]["Error"];
      default: components["responses"]["Error"];
    };
  };
  listThemes: {
    parameters: {
      query?: never;
      header: {
        /** @description イベントID。所有者IDやroleは受け取らない。 */
        "X-Event-ID": components["parameters"]["EventId"];
        /** @description Cookie認証の書込みでは必須。GET/HEADとBearer認証では不要。GET /meで取得するセッション束縛値。 */
        "X-CSRF-Token"?: components["parameters"]["CsrfToken"];
      };
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description お題一覧 */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": {
            items: components["schemas"]["Theme"][];
          };
        };
      };
      401: components["responses"]["Error"];
      default: components["responses"]["Error"];
    };
  };
  listOwnPosts: {
    parameters: {
      query?: {
        cursor?: components["parameters"]["Cursor"];
        limit?: components["parameters"]["Limit"];
      };
      header: {
        /** @description イベントID。所有者IDやroleは受け取らない。 */
        "X-Event-ID": components["parameters"]["EventId"];
      };
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description 本人専用ページ。no-store。 */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": {
            items: components["schemas"]["PostStatus"][];
            next_cursor: string | null;
          };
        };
      };
      401: components["responses"]["Error"];
      default: components["responses"]["Error"];
    };
  };
  reportPost: {
    parameters: {
      query?: never;
      header: {
        /** @description イベントID。所有者IDやroleは受け取らない。 */
        "X-Event-ID": components["parameters"]["EventId"];
        /** @description Cookie認証の書込みでは必須。GET/HEADとBearer認証では不要。GET /meで取得するセッション束縛値。 */
        "X-CSRF-Token"?: components["parameters"]["CsrfToken"];
      };
      path: {
        post_id: components["parameters"]["PostId"];
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": {
          /** @enum {string} */
          reason: "privacy" | "sexual" | "violence" | "harassment" | "other";
          detail?: string;
        };
      };
    };
    responses: {
      /** @description 処理完了 */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["Acknowledgement"];
        };
      };
      401: components["responses"]["Error"];
      default: components["responses"]["Error"];
    };
  };
  createAppeal: {
    parameters: {
      query?: never;
      header: {
        /** @description イベントID。所有者IDやroleは受け取らない。 */
        "X-Event-ID": components["parameters"]["EventId"];
        /** @description Cookie認証の書込みでは必須。GET/HEADとBearer認証では不要。GET /meで取得するセッション束縛値。 */
        "X-CSRF-Token"?: components["parameters"]["CsrfToken"];
      };
      path?: never;
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": {
          /** Format: uuid */
          post_id?: string | null;
          message: string;
        };
      };
    };
    responses: {
      /** @description 処理完了 */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["Acknowledgement"];
        };
      };
      401: components["responses"]["Error"];
      default: components["responses"]["Error"];
    };
  };
  getAdminFeed: {
    parameters: {
      query?: {
        cursor?: components["parameters"]["Cursor"];
        limit?: components["parameters"]["Limit"];
      };
      header: {
        /** @description イベントID。所有者IDやroleは受け取らない。 */
        "X-Event-ID": components["parameters"]["EventId"];
      };
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description 監視専用のno-storeレスポンス */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["AdminPostPage"];
        };
      };
      401: components["responses"]["Error"];
      default: components["responses"]["Error"];
    };
  };
  hidePost: {
    parameters: {
      query?: never;
      header: {
        /** @description イベントID。所有者IDやroleは受け取らない。 */
        "X-Event-ID": components["parameters"]["EventId"];
        /** @description Cookie認証の書込みでは必須。GET/HEADとBearer認証では不要。GET /meで取得するセッション束縛値。 */
        "X-CSRF-Token"?: components["parameters"]["CsrfToken"];
      };
      path: {
        post_id: components["parameters"]["PostId"];
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["AdminAction"];
      };
    };
    responses: {
      /** @description 処理完了 */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["Acknowledgement"];
        };
      };
      401: components["responses"]["Error"];
      default: components["responses"]["Error"];
    };
  };
  restorePost: {
    parameters: {
      query?: never;
      header: {
        /** @description イベントID。所有者IDやroleは受け取らない。 */
        "X-Event-ID": components["parameters"]["EventId"];
        /** @description Cookie認証の書込みでは必須。GET/HEADとBearer認証では不要。GET /meで取得するセッション束縛値。 */
        "X-CSRF-Token"?: components["parameters"]["CsrfToken"];
      };
      path: {
        post_id: components["parameters"]["PostId"];
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["AdminAction"];
      };
    };
    responses: {
      /** @description 処理完了 */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["Acknowledgement"];
        };
      };
      401: components["responses"]["Error"];
      default: components["responses"]["Error"];
    };
  };
  deletePost: {
    parameters: {
      query?: never;
      header: {
        /** @description イベントID。所有者IDやroleは受け取らない。 */
        "X-Event-ID": components["parameters"]["EventId"];
        /** @description Cookie認証の書込みでは必須。GET/HEADとBearer認証では不要。GET /meで取得するセッション束縛値。 */
        "X-CSRF-Token"?: components["parameters"]["CsrfToken"];
      };
      path: {
        post_id: components["parameters"]["PostId"];
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["AdminAction"];
      };
    };
    responses: {
      /** @description 処理完了 */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["Acknowledgement"];
        };
      };
      401: components["responses"]["Error"];
      default: components["responses"]["Error"];
    };
  };
  reassignTheme: {
    parameters: {
      query?: never;
      header: {
        /** @description イベントID。所有者IDやroleは受け取らない。 */
        "X-Event-ID": components["parameters"]["EventId"];
        /** @description Cookie認証の書込みでは必須。GET/HEADとBearer認証では不要。GET /meで取得するセッション束縛値。 */
        "X-CSRF-Token"?: components["parameters"]["CsrfToken"];
      };
      path: {
        post_id: components["parameters"]["PostId"];
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": {
          /** Format: uuid */
          theme_id: string | null;
          expected_version: number;
          reason: string;
        };
      };
    };
    responses: {
      /** @description 処理完了 */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["Acknowledgement"];
        };
      };
      401: components["responses"]["Error"];
      default: components["responses"]["Error"];
    };
  };
  banUser: {
    parameters: {
      query?: never;
      header: {
        /** @description イベントID。所有者IDやroleは受け取らない。 */
        "X-Event-ID": components["parameters"]["EventId"];
        /** @description Cookie認証の書込みでは必須。GET/HEADとBearer認証では不要。GET /meで取得するセッション束縛値。 */
        "X-CSRF-Token"?: components["parameters"]["CsrfToken"];
      };
      path: {
        user_id: components["parameters"]["UserId"];
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": {
          reason: string;
        };
      };
    };
    responses: {
      /** @description 処理完了 */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["Acknowledgement"];
        };
      };
      401: components["responses"]["Error"];
      default: components["responses"]["Error"];
    };
  };
  unbanUser: {
    parameters: {
      query?: never;
      header: {
        /** @description イベントID。所有者IDやroleは受け取らない。 */
        "X-Event-ID": components["parameters"]["EventId"];
        /** @description Cookie認証の書込みでは必須。GET/HEADとBearer認証では不要。GET /meで取得するセッション束縛値。 */
        "X-CSRF-Token"?: components["parameters"]["CsrfToken"];
      };
      path: {
        user_id: components["parameters"]["UserId"];
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": {
          reason: string;
        };
      };
    };
    responses: {
      /** @description 処理完了 */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["Acknowledgement"];
        };
      };
      401: components["responses"]["Error"];
      default: components["responses"]["Error"];
    };
  };
  getSettings: {
    parameters: {
      query?: never;
      header: {
        /** @description イベントID。所有者IDやroleは受け取らない。 */
        "X-Event-ID": components["parameters"]["EventId"];
        /** @description Cookie認証の書込みでは必須。GET/HEADとBearer認証では不要。GET /meで取得するセッション束縛値。 */
        "X-CSRF-Token"?: components["parameters"]["CsrfToken"];
      };
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description 設定値（秘密・Webhook URLは含まない）。no-store。 */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["Settings"];
        };
      };
      401: components["responses"]["Error"];
      default: components["responses"]["Error"];
    };
  };
  updateSettings: {
    parameters: {
      query?: never;
      header: {
        /** @description イベントID。所有者IDやroleは受け取らない。 */
        "X-Event-ID": components["parameters"]["EventId"];
        /** @description Cookie認証の書込みでは必須。GET/HEADとBearer認証では不要。GET /meで取得するセッション束縛値。 */
        "X-CSRF-Token"?: components["parameters"]["CsrfToken"];
      };
      path?: never;
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["Settings"];
      };
    };
    responses: {
      /** @description 処理完了 */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["Acknowledgement"];
        };
      };
      401: components["responses"]["Error"];
      default: components["responses"]["Error"];
    };
  };
  listAdminThemes: {
    parameters: {
      query?: never;
      header: {
        /** @description イベントID。所有者IDやroleは受け取らない。 */
        "X-Event-ID": components["parameters"]["EventId"];
        /** @description Cookie認証の書込みでは必須。GET/HEADとBearer認証では不要。GET /meで取得するセッション束縛値。 */
        "X-CSRF-Token"?: components["parameters"]["CsrfToken"];
      };
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description お題一覧 */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": {
            items: components["schemas"]["Theme"][];
          };
        };
      };
      401: components["responses"]["Error"];
      default: components["responses"]["Error"];
    };
  };
  createTheme: {
    parameters: {
      query?: never;
      header: {
        /** @description イベントID。所有者IDやroleは受け取らない。 */
        "X-Event-ID": components["parameters"]["EventId"];
        /** @description Cookie認証の書込みでは必須。GET/HEADとBearer認証では不要。GET /meで取得するセッション束縛値。 */
        "X-CSRF-Token"?: components["parameters"]["CsrfToken"];
      };
      path?: never;
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["ThemeInput"];
      };
    };
    responses: {
      /** @description 処理完了 */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["Acknowledgement"];
        };
      };
      401: components["responses"]["Error"];
      default: components["responses"]["Error"];
    };
  };
  updateTheme: {
    parameters: {
      query?: never;
      header: {
        /** @description イベントID。所有者IDやroleは受け取らない。 */
        "X-Event-ID": components["parameters"]["EventId"];
        /** @description Cookie認証の書込みでは必須。GET/HEADとBearer認証では不要。GET /meで取得するセッション束縛値。 */
        "X-CSRF-Token"?: components["parameters"]["CsrfToken"];
      };
      path: {
        theme_id: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["ThemeInput"];
      };
    };
    responses: {
      /** @description 処理完了 */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["Acknowledgement"];
        };
      };
      401: components["responses"]["Error"];
      default: components["responses"]["Error"];
    };
  };
  deleteTheme: {
    parameters: {
      query?: never;
      header: {
        /** @description イベントID。所有者IDやroleは受け取らない。 */
        "X-Event-ID": components["parameters"]["EventId"];
        /** @description Cookie認証の書込みでは必須。GET/HEADとBearer認証では不要。GET /meで取得するセッション束縛値。 */
        "X-CSRF-Token"?: components["parameters"]["CsrfToken"];
      };
      path: {
        theme_id: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description 処理完了 */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["Acknowledgement"];
        };
      };
      401: components["responses"]["Error"];
      default: components["responses"]["Error"];
    };
  };
  listAppeals: {
    parameters: {
      query?: {
        cursor?: components["parameters"]["Cursor"];
        limit?: components["parameters"]["Limit"];
      };
      header: {
        /** @description イベントID。所有者IDやroleは受け取らない。 */
        "X-Event-ID": components["parameters"]["EventId"];
      };
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description no-storeの異議申立て一覧 */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": {
            items: components["schemas"]["Appeal"][];
            next_cursor: string | null;
          };
        };
      };
      401: components["responses"]["Error"];
      default: components["responses"]["Error"];
    };
  };
  resolveAppeal: {
    parameters: {
      query?: never;
      header: {
        /** @description イベントID。所有者IDやroleは受け取らない。 */
        "X-Event-ID": components["parameters"]["EventId"];
        /** @description Cookie認証の書込みでは必須。GET/HEADとBearer認証では不要。GET /meで取得するセッション束縛値。 */
        "X-CSRF-Token"?: components["parameters"]["CsrfToken"];
      };
      path: {
        appeal_id: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": {
          /** @enum {string} */
          status: "resolved" | "rejected";
          reason: string;
        };
      };
    };
    responses: {
      /** @description 処理完了 */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["Acknowledgement"];
        };
      };
      401: components["responses"]["Error"];
      default: components["responses"]["Error"];
    };
  };
  likePost: {
    parameters: {
      query?: never;
      header: {
        /** @description イベントID。所有者IDやroleは受け取らない。 */
        "X-Event-ID": components["parameters"]["EventId"];
        /** @description Cookie認証の書込みでは必須。GET/HEADとBearer認証では不要。GET /meで取得するセッション束縛値。 */
        "X-CSRF-Token"?: components["parameters"]["CsrfToken"];
      };
      path: {
        post_id: components["parameters"]["PostId"];
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description 処理完了 */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["Acknowledgement"];
        };
      };
      401: components["responses"]["Error"];
      default: components["responses"]["Error"];
    };
  };
  unlikePost: {
    parameters: {
      query?: never;
      header: {
        /** @description イベントID。所有者IDやroleは受け取らない。 */
        "X-Event-ID": components["parameters"]["EventId"];
        /** @description Cookie認証の書込みでは必須。GET/HEADとBearer認証では不要。GET /meで取得するセッション束縛値。 */
        "X-CSRF-Token"?: components["parameters"]["CsrfToken"];
      };
      path: {
        post_id: components["parameters"]["PostId"];
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description 処理完了 */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["Acknowledgement"];
        };
      };
      401: components["responses"]["Error"];
      default: components["responses"]["Error"];
    };
  };
  listOwnLikes: {
    parameters: {
      query?: {
        cursor?: components["parameters"]["Cursor"];
        limit?: components["parameters"]["Limit"];
      };
      header: {
        /** @description イベントID。所有者IDやroleは受け取らない。 */
        "X-Event-ID": components["parameters"]["EventId"];
      };
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description no-storeのID一覧 */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": {
            post_ids: string[];
            next_cursor: string | null;
          };
        };
      };
      401: components["responses"]["Error"];
      default: components["responses"]["Error"];
    };
  };
  listFailures: {
    parameters: {
      query?: {
        cursor?: components["parameters"]["Cursor"];
        limit?: components["parameters"]["Limit"];
      };
      header: {
        /** @description イベントID。所有者IDやroleは受け取らない。 */
        "X-Event-ID": components["parameters"]["EventId"];
      };
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description 失敗した投稿。no-store。 */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["AdminPostPage"];
        };
      };
      401: components["responses"]["Error"];
      default: components["responses"]["Error"];
    };
  };
  retryProcessing: {
    parameters: {
      query?: never;
      header: {
        /** @description イベントID。所有者IDやroleは受け取らない。 */
        "X-Event-ID": components["parameters"]["EventId"];
        /** @description Cookie認証の書込みでは必須。GET/HEADとBearer認証では不要。GET /meで取得するセッション束縛値。 */
        "X-CSRF-Token"?: components["parameters"]["CsrfToken"];
      };
      path: {
        post_id: components["parameters"]["PostId"];
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["AdminAction"];
      };
    };
    responses: {
      /** @description 処理完了 */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["Acknowledgement"];
        };
      };
      401: components["responses"]["Error"];
      default: components["responses"]["Error"];
    };
  };
  getStats: {
    parameters: {
      query?: never;
      header: {
        /** @description イベントID。所有者IDやroleは受け取らない。 */
        "X-Event-ID": components["parameters"]["EventId"];
        /** @description Cookie認証の書込みでは必須。GET/HEADとBearer認証では不要。GET /meで取得するセッション束縛値。 */
        "X-CSRF-Token"?: components["parameters"]["CsrfToken"];
      };
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description 取得日時付き実測値。外部サービスの未取得値はnullであり0ではない。no-store。 */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["Stats"];
        };
      };
      401: components["responses"]["Error"];
      default: components["responses"]["Error"];
    };
  };
  listModerationLogs: {
    parameters: {
      query?: {
        cursor?: components["parameters"]["Cursor"];
        limit?: components["parameters"]["Limit"];
      };
      header: {
        /** @description イベントID。所有者IDやroleは受け取らない。 */
        "X-Event-ID": components["parameters"]["EventId"];
      };
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description 判定ログのキーセットページ。no-store。 */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": {
            items: components["schemas"]["ModerationLog"][];
            next_cursor: string | null;
          };
        };
      };
      401: components["responses"]["Error"];
      default: components["responses"]["Error"];
    };
  };
}

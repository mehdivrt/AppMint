package {{PACKAGE}};

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.graphics.Bitmap;
import android.net.Uri;
import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.ProgressBar;

import androidx.swiperefreshlayout.widget.SwipeRefreshLayout;

public class MainActivity extends Activity {

    private static final int FILE_CHOOSER_REQUEST = 1001;

    private WebView webView;
    private SwipeRefreshLayout refreshLayout;
    private ProgressBar progressBar;
    private ValueCallback<Uri[]> filePathCallback;
    private String startUrl;
    private String startHost;
    private boolean showingOffline = false;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        startUrl = getString(R.string.start_url);
        startHost = Uri.parse(startUrl).getHost();

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(getColor(R.color.splash));

        webView = new WebView(this);
        refreshLayout = new SwipeRefreshLayout(this);
        refreshLayout.setEnabled(getResources().getBoolean(R.bool.pull_to_refresh));
        refreshLayout.setOnRefreshListener(() -> webView.reload());
        refreshLayout.addView(webView, new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        root.addView(refreshLayout, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));

        progressBar = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        progressBar.setMax(100);
        progressBar.setVisibility(View.GONE);
        root.addView(progressBar, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, 8));

        setContentView(root);
        setupWebView();

        if (savedInstanceState != null) {
            webView.restoreState(savedInstanceState);
        } else {
            webView.loadUrl(startUrl);
        }
    }

    private void setupWebView() {
        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        boolean zoom = getResources().getBoolean(R.bool.allow_zoom);
        s.setSupportZoom(zoom);
        s.setBuiltInZoomControls(zoom);
        s.setDisplayZoomControls(false);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        String suffix = getString(R.string.user_agent_suffix);
        if (!suffix.isEmpty()) {
            s.setUserAgentString(s.getUserAgentString() + " " + suffix);
        }

        webView.addJavascriptInterface(new Bridge(), "AppBridge");

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return handleUrl(request.getUrl());
            }

            @Override
            public void onPageStarted(WebView view, String url, Bitmap favicon) {
                if (!showingOffline) {
                    progressBar.setVisibility(View.VISIBLE);
                }
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                progressBar.setVisibility(View.GONE);
                refreshLayout.setRefreshing(false);
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) {
                    showOfflinePage();
                }
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onProgressChanged(WebView view, int newProgress) {
                progressBar.setProgress(newProgress);
            }

            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                                             FileChooserParams params) {
                if (filePathCallback != null) {
                    filePathCallback.onReceiveValue(null);
                }
                filePathCallback = callback;
                try {
                    startActivityForResult(params.createIntent(), FILE_CHOOSER_REQUEST);
                } catch (ActivityNotFoundException e) {
                    filePathCallback = null;
                    return false;
                }
                return true;
            }
        });

        webView.setDownloadListener((url, userAgent, contentDisposition, mimeType, length) -> {
            try {
                startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
            } catch (ActivityNotFoundException ignored) {
            }
        });
    }

    private boolean handleUrl(Uri uri) {
        String scheme = uri.getScheme();
        if (scheme == null) {
            return false;
        }
        if (!scheme.equals("http") && !scheme.equals("https")) {
            // tel:, mailto:, intent:, whatsapp:, etc. -> hand over to the system
            try {
                startActivity(new Intent(Intent.ACTION_VIEW, uri));
            } catch (ActivityNotFoundException ignored) {
            }
            return true;
        }
        if (getResources().getBoolean(R.bool.external_links_in_browser)) {
            String host = uri.getHost();
            if (host != null && startHost != null && !sameSite(host, startHost)) {
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, uri));
                } catch (ActivityNotFoundException ignored) {
                }
                return true;
            }
        }
        return false;
    }

    private static String root(String host) {
        String h = host.toLowerCase();
        return h.startsWith("www.") ? h.substring(4) : h;
    }

    private static boolean sameSite(String a, String b) {
        String ra = root(a);
        String rb = root(b);
        return ra.equals(rb) || ra.endsWith("." + rb) || rb.endsWith("." + ra);
    }

    private void showOfflinePage() {
        showingOffline = true;
        progressBar.setVisibility(View.GONE);
        refreshLayout.setRefreshing(false);
        String bg = String.format("#%06X", 0xFFFFFF & getColor(R.color.splash));
        String html = "<html><head><meta name='viewport' content='width=device-width,initial-scale=1'>"
                + "<style>body{margin:0;height:100vh;display:flex;flex-direction:column;align-items:center;"
                + "justify-content:center;font-family:sans-serif;background:" + bg + ";color:#333;text-align:center;padding:24px}"
                + "button{margin-top:20px;padding:12px 28px;border:0;border-radius:24px;font-size:16px;"
                + "background:#333;color:#fff}</style></head><body>"
                + "<h2>" + getString(R.string.offline_title) + "</h2>"
                + "<p>" + getString(R.string.offline_text) + "</p>"
                + "<button onclick='AppBridge.retry()'>" + getString(R.string.offline_retry) + "</button>"
                + "</body></html>";
        webView.loadDataWithBaseURL(null, html, "text/html", "UTF-8", null);
    }

    private class Bridge {
        @JavascriptInterface
        public void retry() {
            runOnUiThread(() -> {
                showingOffline = false;
                webView.loadUrl(startUrl);
            });
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == FILE_CHOOSER_REQUEST && filePathCallback != null) {
            filePathCallback.onReceiveValue(
                    WebChromeClient.FileChooserParams.parseResult(resultCode, data));
            filePathCallback = null;
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        webView.saveState(outState);
    }

    @Override
    public void onBackPressed() {
        if (webView.canGoBack() && !showingOffline) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }

    @Override
    protected void onPause() {
        super.onPause();
        webView.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        webView.onResume();
    }

    @Override
    protected void onDestroy() {
        webView.destroy();
        super.onDestroy();
    }
}

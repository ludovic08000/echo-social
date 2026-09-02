package fans.forsure.app;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;
import fans.forsure.app.crypto.AegisKeychainPlugin;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(AegisKeychainPlugin.class);
        registerPlugin(LibSignalPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
